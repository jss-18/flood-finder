import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

async function browserHarness(){
  const nodes=new Map(),requests=[];
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{value:'',checked:false,hidden:true,textContent:'',innerHTML:'',dataset:{},classList:{remove(){},toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){}});
    return nodes.get(selector);
  };
  node('#sortFilter').value='priority';
  const incidents=[
    {id:'new',title:'New minor report',description:'New report',category:'road',severity:'low',status:'reported',created_at:'2026-10-23T12:00:00Z'},
    {id:'urgent',title:'Older critical report',description:'Critical report',category:'flood',severity:'critical',status:'reported',created_at:'2026-10-22T12:00:00Z'},
    {id:'closed',title:'Resolved critical report',description:'Closed report',category:'flood',severity:'critical',status:'resolved',created_at:'2026-10-23T13:00:00Z'}
  ];
  let events;
  const context=vm.createContext({
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},body:{addEventListener(){}},visibilityState:'visible'},
    location:{hash:'#home'},window:{scrollTo(){},addEventListener(){}},console,Date,Set,Number,String,Promise,
    setTimeout,clearTimeout,setInterval:()=>0,navigator:{},
    EventSource:class{constructor(){events=this;this.listeners={};}addEventListener(name,fn){this.listeners[name]=fn;}},
    fetch:async path=>{
      requests.push(path);
      const responses={
        '/api/auth/me':{user:{id:'resident',name:'Test resident',role:'resident'}},
        '/api/incidents':{incidents},'/api/incidents/mine':{incidents:[incidents[0]]},
        '/api/stats':{active:2,critical:1,resolved:1,total:3},
        '/api/alerts':{alerts:[],status:'live',area:'FL',fetchedAt:'2026-10-23T12:00:00Z'}
      };
      return {ok:true,json:async()=>responses[path]};
    }
  });
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nglobalThis.driver={initialize,filteredIncidents,state};',context);
  await context.driver.initialize();
  return {driver:context.driver,node,requests,get events(){return events;}};
}
test('priority puts open urgent reports first; newest and ownership filters work together',async()=>{
  const browser=await browserHarness();
  assert.deepEqual(Array.from(browser.driver.filteredIncidents(),i=>i.id),['urgent','new','closed']);
  browser.node('#sortFilter').value='newest';
  assert.deepEqual(Array.from(browser.driver.filteredIncidents(),i=>i.id),['closed','new','urgent']);
  browser.node('#myReportsFilter').checked=true;
  assert.deepEqual(Array.from(browser.driver.filteredIncidents(),i=>i.id),['new']);
  browser.node('#severityFilter').value='critical';
  assert.equal(browser.driver.filteredIncidents().length,0);
});
test('a burst of incident and assignment events still refreshes public reports',async()=>{
  const browser=await browserHarness();browser.requests.length=0;
  browser.events.listeners.change({data:JSON.stringify({kind:'incidents'})});
  browser.events.listeners.change({data:JSON.stringify({kind:'assignments'})});
  await new Promise(resolve=>setTimeout(resolve,380));
  assert.ok(browser.requests.includes('/api/incidents'));
  assert.ok(browser.requests.includes('/api/stats'));
  assert.ok(browser.requests.includes('/api/incidents/mine'));
  browser.events.listeners.change({data:'invalid-json'});
});
