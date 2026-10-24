import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';

const folder=mkdtempSync(join(tmpdir(),'flood-finder-test-'));
const {server,db}=createApp({databasePath:join(folder,'test.sqlite'),weatherFetch:async()=>({ok:true,json:async()=>({features:[]})})});
let base, residentCookie, adminCookie, responderCookie, reportId, teamId, assignmentId;
before(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r));rmSync(folder,{recursive:true,force:true})});
async function request(path,method='GET',body,cookie,headers={}){
  const resp=await fetch(base+path,{method,headers:{...method!=='GET'?{'Content-Type':'application/json','X-FloodFinder':'1'}:{},...cookie?{Cookie:cookie}:{},...headers},body:method==='GET'?undefined:JSON.stringify(body||{})});
  return {status:resp.status,data:await resp.json(),cookie:resp.headers.get('set-cookie')?.split(';')[0]};
}
const register=(name,email)=>request('/api/auth/register','POST',{name,email,password:'Strong Password!12345'});

test('secure registration and authentication',async()=>{
  const r=await register('Reporter','reporter@example.com');assert.equal(r.status,201);residentCookie=r.cookie;
  assert.equal(r.data.user.role,'resident');
  assert.ok(!JSON.stringify(r.data).includes('password'));
  const pw=db.prepare('SELECT password_hash FROM users WHERE email=?').get('reporter@example.com').password_hash;
  assert.ok(pw.startsWith('scrypt$'));assert.ok(!pw.includes('Strong Password'));
  const wrong=await request('/api/auth/login','POST',{email:'reporter@example.com',password:'wrong'});
  assert.equal(wrong.status,401);
  const duplicate=await register('Reporter','reporter@example.com');assert.equal(duplicate.status,409);
  const me=await request('/api/auth/me','GET',null,residentCookie);assert.equal(me.data.user.email,'reporter@example.com');
});
test('role escalation is forbidden and bad CSRF header rejected',async()=>{
  const unauth=await request('/api/admin/users');assert.equal(unauth.status,401);
  const target=await request('/api/admin/users','GET',null,residentCookie);assert.equal(target.status,403);
  const csrf=await request('/api/incidents','POST',{title:'Test missing header'},residentCookie,{'X-FloodFinder':'0'});assert.equal(csrf.status,403);
  const user=db.prepare('SELECT id FROM users WHERE email=?').get('reporter@example.com');
  const attempt=await request('/api/admin/users/'+user.id,'PATCH',{role:'admin'},residentCookie);assert.equal(attempt.status,403);
});
test('resident can publish a real map report',async()=>{
  const invalid=await request('/api/incidents','POST',{title:'Storm damage',description:'This is a serious problem.',category:'flood',severity:'high',lat:190,lon:-80},residentCookie);
  assert.equal(invalid.status,400);
  const good=await request('/api/incidents','POST',{title:'Bridge approach flooded',description:'Water is covering both lanes near the bridge approach.',category:'flood',severity:'high',lat:26.35,lon:-80.13,address:'Bridge access'},residentCookie);
  assert.equal(good.status,201);assert.equal(good.data.incident.status,'reported');reportId=good.data.incident.id;
  const list=await request('/api/incidents');assert.ok(list.data.incidents.some(i=>i.id===reportId));
  const full=await request('/api/incidents/'+reportId);assert.equal(full.data.updates.length,1);
  const stats=await request('/api/stats');assert.equal(stats.data.active,1);
});
test('admin creates teams, assigns incident; responder advances job',async()=>{
  const ar=await register('Commander','commander@example.com');assert.equal(ar.status,201);
  const rr=await register('Crew Lead','lead@example.com');assert.equal(rr.status,201);
  const admin=db.prepare('SELECT id FROM users WHERE email=?').get('commander@example.com');
  const lead=db.prepare('SELECT id FROM users WHERE email=?').get('lead@example.com');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  db.prepare("UPDATE users SET role='responder' WHERE id=?").run(lead.id);
  adminCookie=ar.cookie;responderCookie=rr.cookie;
  const t=await request('/api/admin/teams','POST',{name:'Road Team 1',specialty:'Road clearing',contact:'radio 5',base_lat:26.33,base_lon:-80.11,lead_user_id:lead.id},adminCookie);
  assert.equal(t.status,201);teamId=t.data.team.id;
  const update=await request('/api/admin/incidents/'+reportId,'PATCH',{status:'verified',severity:'critical',team_id:teamId,note:'Verified by public works'},adminCookie);
  assert.equal(update.status,200);assert.equal(update.data.incident.status,'dispatched');
  const assigned=await request('/api/assignments/mine','GET',null,responderCookie);
  assert.equal(assigned.status,200);assert.equal(assigned.data.assignments.length,1);assignmentId=assigned.data.assignments[0].id;
  const wrong=await request('/api/assignments/'+assignmentId,'PATCH',{status:'acknowledged'},residentCookie);assert.equal(wrong.status,403);
  for(const status of ['acknowledged','en_route','on_scene','completed']){
    const progress=await request('/api/assignments/'+assignmentId,'PATCH',{status},responderCookie);assert.equal(progress.status,200);
  }
  const closed=await request('/api/incidents/'+reportId);assert.equal(closed.data.incident.status,'resolved');
  assert.ok(closed.data.updates.length>=5);
  assert.equal((await request('/api/stats')).data.resolved,1);
});
test('official feed, health, routes and logout',async()=>{
  assert.equal((await request('/api/health')).data.ok,true);
  const alerts=await request('/api/alerts');assert.equal(alerts.data.status,'live');assert.equal(alerts.data.alerts.length,0);
  const badroute=await request('/api/route?from_lat=999&from_lon=1&to_lat=1&to_lon=1','GET',null,adminCookie);assert.equal(badroute.status,400);
  const logout=await request('/api/auth/logout','POST',{},residentCookie);assert.equal(logout.status,200);
  const me=await request('/api/auth/me','GET',null,residentCookie);assert.equal(me.data.user,null);
});


test('team creation preserves availability and validates it',async()=>{
  const offline=await request('/api/admin/teams','POST',{name:'Reserve crew',specialty:'Supplies',availability:'offline'},adminCookie);
  assert.equal(offline.status,201);assert.equal(offline.data.team.availability,'offline');
  const invalid=await request('/api/admin/teams','POST',{name:'Invalid crew',specialty:'Supplies',availability:'unknown'},adminCookie);
  assert.equal(invalid.status,400);
});
test('rejection cancels dispatch, reopening creates a fresh assignment, and progress cannot skip steps',async()=>{
  const created=await request('/api/incidents','POST',{title:'Test blocked access',description:'A fallen branch is blocking this access road.',category:'road',severity:'moderate',lat:26.35,lon:-80.13},adminCookie);
  assert.equal(created.status,201);const ident=created.data.incident.id;
  await request('/api/admin/incidents/'+ident,'PATCH',{status:'verified',team_id:teamId},adminCookie);
  let assignments=(await request('/api/assignments/mine','GET',null,responderCookie)).data.assignments;
  const first=assignments.find(a=>a.incident_id===ident);
  const skipped=await request('/api/assignments/'+first.id,'PATCH',{status:'completed'},responderCookie);
  assert.equal(skipped.status,409);
  await request('/api/admin/incidents/'+ident,'PATCH',{status:'rejected'},adminCookie);
  const progress=await request('/api/assignments/'+first.id,'PATCH',{status:'acknowledged'},responderCookie);
  assert.equal(progress.status,409);
  assert.equal((await request('/api/incidents/'+ident)).data.incident.status,'rejected');
  assignments=(await request('/api/assignments/mine','GET',null,responderCookie)).data.assignments;
  assert.equal(assignments.find(a=>a.id===first.id).status,'cancelled');
  await request('/api/admin/incidents/'+ident,'PATCH',{status:'verified'},adminCookie);
  assignments=(await request('/api/assignments/mine','GET',null,responderCookie)).data.assignments;
  const fresh=assignments.find(a=>a.incident_id===ident&&a.status==='assigned');
  assert.ok(fresh);assert.notEqual(fresh.id,first.id);
  assert.equal((await request('/api/assignments/'+fresh.id,'PATCH',{status:'acknowledged'},responderCookie)).status,200);
});
