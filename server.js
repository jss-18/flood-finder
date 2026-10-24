import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { connect, now, id, runTransaction, logUpdate, audit, INCIDENT_SELECT } from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const categories = ['flood','road','power','medical','debris','shelter','other'];
const severities = ['low','moderate','high','critical'];
const statuses = ['reported','verified','dispatched','in_progress','resolved','rejected'];
const assignmentStates = ['assigned','acknowledged','en_route','on_scene','completed'];
const teamStates = ['available','deployed','offline'];
const SESSION_DAYS = 7;
const hashToken = token => createHash('sha256').update(token).digest('hex');
const err = (code, message) => Object.assign(new Error(message), { code });
const text = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const number = v => v === '' || v === null || v === undefined ? NaN : Number(v);
const validLat = v => Number.isFinite(v) && v >= -90 && v <= 90;
const validLon = v => Number.isFinite(v) && v >= -180 && v <= 180;
function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N:16384, r:8, p:1, maxmem:64*1024*1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, encoded) {
  try {
    const [alg,n,r,p,salt,expected] = encoded.split('$');
    if (alg !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1') return false;
    const target = Buffer.from(expected, 'base64url');
    const actual = scryptSync(password, Buffer.from(salt,'base64url'), target.length, {N:16384,r:8,p:1,maxmem:64*1024*1024});
    return target.length === actual.length && timingSafeEqual(target, actual);
  } catch { return false; }
}
function userPublic(user) {
  return user && {id:user.id, name:user.name, email:user.email, role:user.role, created_at:user.created_at};
}
function response(res, status, data, headers = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
  res.end(payload);
}
function cookieToken(req) {
  const match = /(?:^|;\s*)ff_session=([^;]+)/.exec(req.headers.cookie || '');
  return match?.[1] || null;
}
function getUser(db, req) {
  const token = cookieToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT u.id,u.name,u.email,u.role,u.created_at FROM users u
    JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .get(hashToken(token),now()) || null;
}
function setCookie(req, res, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
  return `ff_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
const baseHeaders = {
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin',
  'X-Frame-Options':'DENY', 'Permissions-Policy':'camera=(), microphone=(), geolocation=(self)',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
};
async function bodyJSON(req) {
  if (!(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw err(415,'Send JSON content');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32000) throw err(413,'Request too large');
    chunks.push(chunk);
  }
  try { const obj = JSON.parse(Buffer.concat(chunks).toString()); if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw Error(); return obj; }
  catch { throw err(400,'Invalid JSON body'); }
}
const field = (value, min, max, name) => {
  const v=text(value,max+1);
  if(v.length<min || v.length>max) throw err(400,`${name} must be ${min}–${max} characters`);
  return v;
};
function requireRole(user, roles) {
  if (!user) throw err(401,'Sign in to continue');
  if (!roles.includes(user.role)) throw err(403,'You do not have permission');
}
function ipAddress(req) {
  return process.env.TRUST_PROXY==='1' ? text((req.headers['x-forwarded-for']||'').split(',')[0],64) || req.socket.remoteAddress : req.socket.remoteAddress;
}
function throttle(rate, key, limit, windowMs) {
  const time=Date.now(); const existing=rate.get(key);
  if(!existing || existing.reset<time) {rate.set(key,{count:1,reset:time+windowMs});return;}
  if(++existing.count>limit) throw err(429,'Too many requests. Please try again later.');
}
function parseCoords(body, latKey='lat', lonKey='lon') {
  const lat=number(body[latKey]),lon=number(body[lonKey]);
  if(!validLat(lat)||!validLon(lon)) throw err(400,'Choose a valid location on the map');
  return {lat,lon};
}
function readIncident(db, ident) { return db.prepare(INCIDENT_SELECT+' WHERE i.id=?').get(ident); }
const staticFiles = new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css'],['/favicon.svg','favicon.svg']]);
const contentTypes = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};

export function createApp({databasePath=process.env.DATABASE_PATH || './data/flood-finder.sqlite', weatherFetch=globalThis.fetch}={}) {
  const db = connect(databasePath);
  const rate=new Map(); const streams=new Set();
  let weatherCache={expires:0, result:null};
  const broadcast = message => { for (const stream of streams) { try {stream.write(`event: change\ndata: ${JSON.stringify(message)}\n\n`);}catch{streams.delete(stream);} } };
  const handler=async(req,res)=>{
    Object.entries(baseHeaders).forEach(([key,val])=>res.setHeader(key,val));
    try {
      const url=new URL(req.url,'http://internal');
      const path=url.pathname;
      if(req.method==='GET' && staticFiles.has(path)) {
        const name=staticFiles.get(path);const ext=name.split('.').pop();
        const source=await readFile(join(HERE,'public',name));
        res.writeHead(200,{'Content-Type':contentTypes[ext],'Cache-Control':ext==='html'?'no-cache':'public, max-age=300'});res.end(source);return;
      }
      if(req.method==='GET' && path==='/api/health') return response(res,200,{ok:true,service:'flood-finder',time:now()});
      if(!path.startsWith('/api/')) return response(res,404,{error:'Not found'});
      const ip=ipAddress(req);
      if(req.method!=='GET' && req.method!=='HEAD') {
        // JSON + a non-simple custom header prevents cross-site form and fetch CSRF.
        if(req.headers['x-floodfinder']!=='1') throw err(403,'Missing application request header');
        if(req.headers['sec-fetch-site']==='cross-site') throw err(403,'Cross-site requests blocked');
        throttle(rate,`write:${ip}`,100,60000);
      }
      if(req.method==='GET' && path==='/api/stream') {
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(': connected\n\n');streams.add(res);
        const heartbeat=setInterval(()=>{try{res.write(': keepalive\n\n')}catch{}},25000);
        req.on('close',()=>{clearInterval(heartbeat);streams.delete(res)});return;
      }
      const user=getUser(db,req);
      if(req.method==='GET' && path==='/api/auth/me') return response(res,200,{user:userPublic(user)});
      if(req.method==='POST' && path==='/api/auth/register') {
        throttle(rate,`register:${ip}`,8,15*60000);
        const b=await bodyJSON(req);
        const name=field(b.name,2,80,'Name');
        const email=field(b.email,5,254,'Email').toLowerCase();
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400,'Enter a valid email address');
        const password=b.password;
        if(typeof password!=='string'||password.length<12||Buffer.byteLength(password)>256) throw err(400,'Use a password of 12–256 bytes');
        if(db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw err(409,'An account with that email already exists');
        const uid=id(),date=now();
        const secret=passwordHash(password);
        const session=randomBytes(32).toString('hex');
        runTransaction(db,()=>{
          db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(uid,name,email,secret,'resident',date);
          db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(session),uid,new Date(Date.now()+SESSION_DAYS*86400000).toISOString(),date);
        });
        res.setHeader('Set-Cookie',setCookie(req,res,session,SESSION_DAYS*86400));
        return response(res,201,{user:{id:uid,name,email,role:'resident',created_at:date}});
      }
      if(req.method==='POST' && path==='/api/auth/login') {
        throttle(rate,`login:${ip}`,12,15*60000);
        const b=await bodyJSON(req),email=text(b.email,254).toLowerCase();
        const found=db.prepare('SELECT * FROM users WHERE email=?').get(email);
        // Always do equivalent password work even if an email does not exist.
        const dummy='scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$'+Buffer.alloc(64).toString('base64url');
        if(typeof b.password!=='string'||!verifyPassword(b.password,found?.password_hash||dummy)||!found) throw err(401,'Invalid email or password');
        const session=randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(session),found.id,new Date(Date.now()+SESSION_DAYS*86400000).toISOString(),now());
        res.setHeader('Set-Cookie',setCookie(req,res,session,SESSION_DAYS*86400));
        return response(res,200,{user:userPublic(found)});
      }
      if(req.method==='POST' && path==='/api/auth/logout') {
        if(cookieToken(req)) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookieToken(req)));
        res.setHeader('Set-Cookie',setCookie(req,res,'',0));
        return response(res,200,{ok:true});
      }
      if(req.method==='GET' && path==='/api/stats') {
        const total=db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n;
        const active=db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status NOT IN ('resolved','rejected')").get().n;
        const resolved=db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status='resolved'").get().n;
        const critical=db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE severity='critical' AND status NOT IN ('resolved','rejected')").get().n;
        return response(res,200,{total,active,resolved,critical});
      }
      if(req.method==='GET' && path==='/api/incidents') {
        const filters=[];const args=[];
        if(url.searchParams.has('status')) {const s=url.searchParams.get('status');if(!statuses.includes(s))throw err(400,'Invalid status');filters.push('i.status=?');args.push(s);}
        if(url.searchParams.has('category')) {const c=url.searchParams.get('category');if(!categories.includes(c))throw err(400,'Invalid category');filters.push('i.category=?');args.push(c);}
        if(url.searchParams.has('severity')) {const s=url.searchParams.get('severity');if(!severities.includes(s))throw err(400,'Invalid severity');filters.push('i.severity=?');args.push(s);}
        const q=text(url.searchParams.get('q'),100);
        if(q){filters.push('(i.title LIKE ? OR i.address LIKE ? OR i.description LIKE ?)');args.push(...Array(3).fill('%'+q.replace(/[%_]/g,'')+'%'));}
        if(url.searchParams.has('bbox')){
          const n=url.searchParams.get('bbox').split(',').map(Number);
          if(n.length!==4||n.some(x=>!Number.isFinite(x))||n[0]>=n[2]||n[1]>=n[3]||!validLon(n[0])||!validLat(n[1])||!validLon(n[2])||!validLat(n[3])) throw err(400,'Invalid bounding box');
          filters.push('i.lon BETWEEN ? AND ? AND i.lat BETWEEN ? AND ?');args.push(n[0],n[2],n[1],n[3]);
        }
        const items=db.prepare(INCIDENT_SELECT+(filters.length?' WHERE '+filters.join(' AND '):'')+' ORDER BY i.created_at DESC LIMIT 1500').all(...args);
        return response(res,200,{incidents:items,limit:1500});
      }
      if(req.method==='POST' && path==='/api/incidents') {
        requireRole(user,['resident','responder','admin']);
        throttle(rate,`report:${user.id}`,12,3600000);
        const b=await bodyJSON(req);
        const title=field(b.title,5,120,'Title'),description=field(b.description,15,2000,'Description');
        if(!categories.includes(b.category)||!severities.includes(b.severity))throw err(400,'Choose a category and severity');
        const {lat,lon}=parseCoords(b);
        const address=text(b.address,180);const ident=id(),date=now();
        runTransaction(db,()=>{
          db.prepare(`INSERT INTO incidents (id,title,description,category,severity,status,lat,lon,address,created_by,team_id,created_at,updated_at)
            VALUES (?,?,?,?,?,'reported',?,?,?,?,NULL,?,?)`)
            .run(ident,title,description,b.category,b.severity,lat,lon,address,user.id,date,date);
          logUpdate(db,ident,user.id,'reported','Report submitted by community member; not yet verified');
          audit(db,user.id,'incident_created',ident);
        });
        broadcast({kind:'incidents',id:ident});
        return response(res,201,{incident:readIncident(db,ident)});
      }
      let match=path.match(/^\/api\/incidents\/([a-f\d-]{36})$/);
      if(req.method==='GET' && match) {
        const incident=readIncident(db,match[1]);if(!incident)throw err(404,'Report not found');
        const updates=db.prepare(`SELECT u.action,u.message,u.created_at, a.role AS actor_role FROM updates u
          JOIN users a ON a.id=u.actor_id WHERE u.incident_id=? ORDER BY u.created_at DESC LIMIT 100`).all(match[1]);
        return response(res,200,{incident,updates});
      }
      if(req.method==='GET' && path==='/api/incidents/mine') {
        requireRole(user,['resident','responder','admin']);
        return response(res,200,{incidents:db.prepare(INCIDENT_SELECT+' WHERE i.created_by=? ORDER BY i.created_at DESC LIMIT 200').all(user.id)});
      }
      if(req.method==='GET' && path==='/api/teams') {
        requireRole(user,['responder','admin']);
        const teams=db.prepare(`SELECT t.*,u.name AS lead_name FROM teams t LEFT JOIN users u ON t.lead_user_id=u.id ORDER BY t.name`).all();
        return response(res,200,{teams});
      }
      if(req.method==='GET' && path==='/api/admin/users') {
        requireRole(user,['admin']);
        const users=db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC LIMIT 300').all();
        return response(res,200,{users});
      }
      if(req.method==='PATCH' && (match=path.match(/^\/api\/admin\/users\/([a-f\d-]{36})$/))) {
        requireRole(user,['admin']);const b=await bodyJSON(req);
        if(!['resident','responder','admin'].includes(b.role))throw err(400,'Invalid role');
        const target=db.prepare('SELECT id,role FROM users WHERE id=?').get(match[1]);if(!target)throw err(404,'User not found');
        if(target.role==='admin'&&b.role!=='admin'&&db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n<=1)throw err(409,'Cannot remove the last administrator');
        db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role,target.id);
        audit(db,user.id,'role_changed',target.id);
        return response(res,200,{ok:true});
      }
      if(req.method==='POST' && path==='/api/admin/teams') {
        requireRole(user,['admin']);const b=await bodyJSON(req);
        const name=field(b.name,2,100,'Team name'),specialty=field(b.specialty,2,80,'Specialty'),contact=text(b.contact,120);
        const coordinates= b.base_lat === '' || b.base_lat == null || b.base_lon === '' || b.base_lon == null ? {lat:null,lon:null} : parseCoords(b,'base_lat','base_lon');
        let lead=b.lead_user_id||null;
        if(lead&&!db.prepare("SELECT id FROM users WHERE id=? AND role IN ('responder','admin')").get(lead))throw err(400,'Team lead must have a responder account');
        const availability=b.availability??'available';
        if(!teamStates.includes(availability))throw err(400,'Invalid team availability');
        const ident=id();
        db.prepare('INSERT INTO teams VALUES (?,?,?,?,?,?,?,?,?)').run(ident,name,specialty,contact,coordinates.lat,coordinates.lon,lead,availability,now());
        audit(db,user.id,'team_created',ident);
        broadcast({kind:'teams'});
        return response(res,201,{team:db.prepare('SELECT * FROM teams WHERE id=?').get(ident)});
      }
      if(req.method==='PATCH' && (match=path.match(/^\/api\/admin\/teams\/([a-f\d-]{36})$/))) {
        requireRole(user,['admin']);const b=await bodyJSON(req);
        const existing=db.prepare('SELECT * FROM teams WHERE id=?').get(match[1]);if(!existing)throw err(404,'Team not found');
        const name=b.name===undefined?existing.name:field(b.name,2,100,'Team name');
        const specialty=b.specialty===undefined?existing.specialty:field(b.specialty,2,80,'Specialty');
        const contact=b.contact===undefined?existing.contact:text(b.contact,120);
        const availability=b.availability??existing.availability;
        if(!teamStates.includes(availability))throw err(400,'Invalid team availability');
        const latValue=b.base_lat===undefined?existing.base_lat:b.base_lat;
        const lonValue=b.base_lon===undefined?existing.base_lon:b.base_lon;
        const coordinates=latValue==null||latValue===''||lonValue==null||lonValue===''?{lat:null,lon:null}:parseCoords({lat:latValue,lon:lonValue});
        const lead=b.lead_user_id===undefined?existing.lead_user_id:(b.lead_user_id||null);
        if(lead&&!db.prepare("SELECT id FROM users WHERE id=? AND role IN ('responder','admin')").get(lead))throw err(400,'Team lead must have a responder account');
        db.prepare(`UPDATE teams SET name=?,specialty=?,contact=?,base_lat=?,base_lon=?,lead_user_id=?,availability=? WHERE id=?`)
          .run(name,specialty,contact,coordinates.lat,coordinates.lon,lead,availability,match[1]);
        audit(db,user.id,'team_updated',match[1]);broadcast({kind:'teams'});
        return response(res,200,{team:db.prepare('SELECT * FROM teams WHERE id=?').get(match[1])});
      }
      if(req.method==='PATCH' && (match=path.match(/^\/api\/admin\/incidents\/([a-f\d-]{36})$/))) {
        requireRole(user,['admin']);const b=await bodyJSON(req);
        const incident=readIncident(db,match[1]);if(!incident)throw err(404,'Report not found');
        const status=b.status??incident.status;
        const severity=b.severity??incident.severity;
        if(!statuses.includes(status)||!severities.includes(severity))throw err(400,'Invalid status or severity');
        const team=b.team_id===undefined?incident.team_id:(b.team_id||null);
        if(team&&!db.prepare('SELECT id FROM teams WHERE id=?').get(team))throw err(400,'Team does not exist');
        const note=text(b.note,500);
        const resolvedStatus=team&&['reported','verified'].includes(status)?'dispatched':status;
        runTransaction(db,()=>{
          db.prepare('UPDATE incidents SET status=?,severity=?,team_id=?,updated_at=? WHERE id=?')
            .run(resolvedStatus,severity,team,now(),incident.id);
          if(team!==incident.team_id){
            db.prepare("UPDATE assignments SET status='reassigned',updated_at=? WHERE incident_id=? AND status NOT IN ('completed','reassigned','cancelled')")
              .run(now(),incident.id);
            if(team&&!['resolved','rejected'].includes(resolvedStatus)){db.prepare('INSERT INTO assignments VALUES (?,?,?,?,?,?,?)').run(id(),incident.id,team,'assigned',user.id,now(),now());}
          }
          if(status==='rejected') db.prepare("UPDATE assignments SET status='cancelled',updated_at=? WHERE incident_id=? AND status NOT IN ('completed','reassigned','cancelled')").run(now(),incident.id);
          if(!['resolved','rejected'].includes(resolvedStatus)&&team===incident.team_id&&team&&!db.prepare("SELECT id FROM assignments WHERE incident_id=? AND status NOT IN ('completed','reassigned','cancelled')").get(incident.id)){
            db.prepare('INSERT INTO assignments VALUES (?,?,?,?,?,?,?)').run(id(),incident.id,team,'assigned',user.id,now(),now());
          }
          if(status==='resolved') db.prepare("UPDATE assignments SET status='completed',updated_at=? WHERE incident_id=? AND status NOT IN ('completed','reassigned','cancelled')").run(now(),incident.id);
          logUpdate(db,incident.id,user.id,'administrative_update',note||`Status: ${resolvedStatus}; priority: ${severity}${team?'; team assigned':''}`);
          audit(db,user.id,'incident_updated',incident.id);
        });
        broadcast({kind:'incidents',id:incident.id});broadcast({kind:'assignments'});
        return response(res,200,{incident:readIncident(db,incident.id)});
      }
      if(req.method==='GET' && path==='/api/assignments/mine') {
        requireRole(user,['responder','admin']);
        const sql=`SELECT a.*, i.title,i.description,i.category,i.severity,i.status AS incident_status,
            i.lat,i.lon,i.address, t.name AS team_name FROM assignments a
            JOIN incidents i ON i.id=a.incident_id JOIN teams t ON t.id=a.team_id
            ${user.role==='admin'?'': 'WHERE t.lead_user_id=?'} ORDER BY a.created_at DESC LIMIT 300`;
        const items=user.role==='admin'?db.prepare(sql).all():db.prepare(sql).all(user.id);
        return response(res,200,{assignments:items});
      }
      if(req.method==='PATCH' && (match=path.match(/^\/api\/assignments\/([a-f\d-]{36})$/))) {
        requireRole(user,['responder','admin']);const b=await bodyJSON(req);
        if(!assignmentStates.includes(b.status)||b.status==='assigned')throw err(400,'Invalid progress status');
        const assignment=db.prepare(`SELECT a.*,t.lead_user_id FROM assignments a JOIN teams t ON t.id=a.team_id WHERE a.id=?`).get(match[1]);
        if(!assignment)throw err(404,'Assignment not found');
        if(user.role!=='admin'&&assignment.lead_user_id!==user.id)throw err(403,'This assignment belongs to another team');
        const index=assignmentStates.indexOf(b.status),oldIndex=assignmentStates.indexOf(assignment.status);
        if(oldIndex<0||index!==oldIndex+1)throw err(409,'Assignment must move forward one step at a time');
        const incident=readIncident(db,assignment.incident_id);
        if(['resolved','rejected'].includes(incident.status))throw err(409,'This incident is already closed');
        runTransaction(db,()=>{
          db.prepare('UPDATE assignments SET status=?,updated_at=? WHERE id=?').run(b.status,now(),assignment.id);
          const status=b.status==='completed'?'resolved':'in_progress';
          db.prepare('UPDATE incidents SET status=?,updated_at=? WHERE id=?').run(status,now(),assignment.incident_id);
          logUpdate(db,assignment.incident_id,user.id,'response_progress',`Response team: ${b.status.replaceAll('_',' ')}`);
          audit(db,user.id,'assignment_updated',assignment.id);
        });
        broadcast({kind:'assignments'});broadcast({kind:'incidents',id:assignment.incident_id});
        return response(res,200,{ok:true});
      }
      if(req.method==='GET' && path==='/api/admin/metrics') {
        requireRole(user,['admin']);
        const byCategory=db.prepare('SELECT category AS label,COUNT(*) AS count FROM incidents GROUP BY category ORDER BY count DESC').all();
        const byStatus=db.prepare('SELECT status AS label,COUNT(*) AS count FROM incidents GROUP BY status ORDER BY count DESC').all();
        const days=db.prepare("SELECT substr(created_at,1,10) AS day,COUNT(*) AS count FROM incidents WHERE created_at>=datetime('now','-13 days') GROUP BY substr(created_at,1,10) ORDER BY day").all();
        const responders=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='responder'").get().n;
        const teams=db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
        return response(res,200,{byCategory,byStatus,days,responders,teams});
      }
      if(req.method==='GET' && path==='/api/alerts') {
        if(weatherCache.expires>Date.now())return response(res,200,weatherCache.result);
        const area=text(process.env.NWS_AREAS||'FL',3).toUpperCase();
        if(!/^[A-Z]{2}$/.test(area))throw err(500,'Invalid configured NWS area');
        let result;
        try {
          const external=await weatherFetch(`https://api.weather.gov/alerts/active?area=${area}`,{
            headers:{'User-Agent':process.env.NWS_USER_AGENT||'FloodFinder/1.0 (local response coordination app; admin@example.org)','Accept':'application/geo+json'},signal:AbortSignal.timeout(8000)
          });
          if(!external.ok)throw Error(`NWS HTTP ${external.status}`);
          const data=await external.json();
          const alerts=(data.features||[]).slice(0,150).map(f=>({
            id:String(f.id||''),event:text(f.properties?.event,120),headline:text(f.properties?.headline,280),
            severity:text(f.properties?.severity,20),area:text(f.properties?.areaDesc,300),
            onset:f.properties?.onset,expires:f.properties?.expires,url:f.properties?.['@id']||f.id,
            geometry:f.geometry&&['Polygon','MultiPolygon'].includes(f.geometry.type)?f.geometry:null
          }));
          result={source:'National Weather Service',status:'live',area,alerts,fetchedAt:now()};
          weatherCache={result,expires:Date.now()+10*60000};
        }catch{
          result={source:'National Weather Service',status:'unavailable',area,alerts:[],fetchedAt:now()};
          weatherCache={result,expires:Date.now()+60000};
        }
        return response(res,200,result);
      }
      if(req.method==='GET' && path==='/api/route') {
        requireRole(user,['responder','admin']);
        throttle(rate,`route:${ip}`,30,60000);
        const lat1=number(url.searchParams.get('from_lat')),lon1=number(url.searchParams.get('from_lon'));
        const lat2=number(url.searchParams.get('to_lat')),lon2=number(url.searchParams.get('to_lon'));
        if(!validLat(lat1)||!validLon(lon1)||!validLat(lat2)||!validLon(lon2))throw err(400,'Invalid route coordinates');
        try {
          const base=process.env.OSRM_URL||'https://router.project-osrm.org';
          const remote=await weatherFetch(`${base}/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`,{signal:AbortSignal.timeout(7000)});
          if(!remote.ok)throw Error('Route provider unavailable');
          const obj=await remote.json(),route=obj.routes?.[0];
          if(!route||route.geometry?.type!=='LineString')throw Error('No road route available');
          return response(res,200,{source:'OSRM (estimated)',coordinates:route.geometry.coordinates,distance_m:route.distance,duration_s:route.duration});
        }catch{ return response(res,503,{error:'Road route unavailable. Use verified official navigation before dispatching.'}); }
      }
      return response(res,404,{error:'Endpoint not found'});
    } catch(e) {
      if(!res.headersSent) response(res,e.code&&Number.isInteger(e.code)?e.code:500,{error:e.code?e.message:'Unexpected server error'});
      if(!e.code) console.error('request failure',e);
    }
  };
  const server=http.createServer(handler);
  server.on('close',()=>{for(const stream of streams)stream.end();db.close();});
  return {server,db};
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const {server,db}=createApp();
  const port=Number(process.env.PORT||3000);
  server.listen(port,()=>console.log(`Flood Finder listening on http://localhost:${port}`));
  const cleanup=setInterval(()=>db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now()),3600000);cleanup.unref();
}
