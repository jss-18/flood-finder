/* Flood Finder client: every mutation is backed by a real API endpoint. */
'use strict';
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const allowedViews = ['home','map','admin','tasks','help'];
const categories = {flood:'Flooding',road:'Road / access',power:'Power / utility',medical:'Medical / safety',debris:'Storm debris',shelter:'Shelter need',other:'Other'};
const symbols={flood:'≋',road:'⛔',power:'⚡',medical:'✚',debris:'◈',shelter:'⌂',other:'!'};
const statusLabel = s => ({in_progress:'In progress'}[s] || String(s||'').replaceAll('_',' '));
const escapeHtml = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shortDate = d => d ? new Date(d).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Unknown';
const formatCoordinate = n => Number(n).toFixed(5);
const state={user:null,incidents:[],filtered:[],teams:[],users:[],assignments:[],alerts:[],alertsStatus:'loading',weatherMeta:null,metrics:null,stats:null,map:null,reportMap:null,reportMarker:null,markers:null,weatherLayer:null,routeLayer:null,routeMarkers:null,selected:null,lastRefresh:null,stream:null,authMode:'login',mapReady:false};
let debounceTimer,toastTimer,refreshTimer;
let pendingReport = false;
const pendingChanges = new Set();
let myReportIds = new Set();
async function api(path,{method='GET',body}={}) {
  const opts={method,credentials:'same-origin',headers:{'Accept':'application/json'}};
  if(method!=='GET'){opts.headers['X-FloodFinder']='1';opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body||{});}
  const res=await fetch(path,opts);
  let data;try{data=await res.json();}catch{throw Error('Server sent an invalid response');}
  if(!res.ok)throw Error(data.error||`Request failed (${res.status})`);
  return data;
}
function toast(message,type='success') {
  const el=$('#toast');el.textContent=message;el.className='toast'+(type==='error'?' error':'');el.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,5500);
}
function formError(selector,message){const el=$(selector);el.hidden=!message;el.textContent=message||'';}
function loadingButton(button,yes,label){button.disabled=yes;if(yes){button.dataset.oldLabel=button.textContent;button.textContent='Working…';}else button.textContent=label||button.dataset.oldLabel||button.textContent;}
function openDialog(selector){const el=$(selector);if(!el.open)el.showModal();}
function closeDialog(selector){const el=$(selector);if(el?.open)el.close();}
function requireLogin(onReady){if(state.user){onReady();return;}pendingReport=true;toast('Create an account or sign in to continue your report.');openAuth('register');}
function openAuth(mode='login') {
  state.authMode=mode;
  $('#loginTab').classList.toggle('active',mode==='login');
  $('#registerTab').classList.toggle('active',mode==='register');
  $('#nameField').hidden=mode!=='register';$('#authName').required=mode==='register';
  $('#authPassword').autocomplete=mode==='register'?'new-password':'current-password';
  $('#authPassword').minLength=mode==='register'?12:0;
  $('#passwordHint').hidden=mode!=='register';
  $('#authHeading').textContent=mode==='login'?'Welcome back.':'Join your community.';
  $('#authDesc').textContent=mode==='login'?'Sign in to report incidents and follow your submissions.':'Create a secure account to contribute real incident information.';
  $('#authSubmit').textContent=mode==='login'?'Sign in ↗':'Create account ↗';
  formError('#authError','');openDialog('#authDialog');
}
async function submitAuth(e){
  e.preventDefault();const form=e.currentTarget;
  const b={email:form.elements.email.value,password:form.elements.password.value};
  if(state.authMode==='register')b.name=form.elements.name.value;
  const button=$('#authSubmit');loadingButton(button,true);
  formError('#authError','');
  try{
    const data=await api('/api/auth/'+(state.authMode==='register'?'register':'login'),{method:'POST',body:b});
    state.user=data.user;form.reset();closeDialog('#authDialog');updateAuthUI();await Promise.all([refreshPrivate(),fetchIncidents()]);route();toast('Signed in as '+data.user.name);if(pendingReport){pendingReport=false;openReport();}
  }catch(ex){formError('#authError',ex.message)}finally{loadingButton(button,false,state.authMode==='register'?'Create account ↗':'Sign in ↗');}
}
async function logout(){
  try{await api('/api/auth/logout',{method:'POST'});state.user=null;state.teams=[];state.users=[];state.assignments=[];state.metrics=null;updateAuthUI();route();toast('You have signed out.');}
  catch(e){toast(e.message,'error')}
}
function updateAuthUI(){
  const u=state.user;
  $('#userBadge').hidden=!u;$('#userBadge').textContent=u?.name||'';
  $('#accountButton').hidden=!!u;$('#signUpButton').hidden=!!u;$('#logoutButton').hidden=!u;
  $('#adminNav').hidden=u?.role!=='admin';
  $('#tasksNav').hidden=!u||!['responder','admin'].includes(u.role);
  $('#myReportsControl').hidden=!u;
  if(!u){$('#myReportsFilter').checked=false;myReportIds.clear();renderIncidents();}
}
function route(){
  let target=location.hash.replace(/^#/,'')||'home';
  if(!allowedViews.includes(target))target='home';
  if(target==='admin'&&state.user?.role!=='admin')target='map';
  if(target==='tasks'&&!['responder','admin'].includes(state.user?.role))target='map';
  for(const v of allowedViews)$('#'+v+'View').hidden=v!==target;
  $$('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===target));
  $('.nav-links').classList.remove('open');
  $('#mobileMenu').setAttribute('aria-expanded','false');
  $$('[data-nav]').forEach(el=>{if(el.dataset.nav===target)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  if(target==='map'){
    initializeMap();setTimeout(()=>{state.map?.invalidateSize();},90);
    renderIncidents();renderAlerts();
  }
  if(target==='admin')renderAdmin();
  if(target==='tasks')renderAssignments();
  window.scrollTo({top:0,behavior:'instant'});
}
function statsRender(){
  const s=state.stats||{active:0,critical:0,resolved:0,total:0};
  $('#statActive').textContent=s.active;$('#statCritical').textContent=s.critical;$('#statResolved').textContent=s.resolved;
}
async function fetchIncidents(){
  const [incidentData,statsData,mine]=await Promise.all([api('/api/incidents'),api('/api/stats'),state.user?api('/api/incidents/mine'):Promise.resolve({incidents:[]})]);
  myReportIds=new Set(mine.incidents.map(i=>i.id));
  $('#connectionNotice').hidden=true;
  state.incidents=incidentData.incidents;state.stats=statsData;state.lastRefresh=new Date();
  $('#lastUpdated').textContent='Updated '+state.lastRefresh.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  statsRender();renderIncidents();if(!$('#adminView').hidden)renderAdmin();
}
async function fetchAlerts(){
  const data=await api('/api/alerts');state.alerts=data.alerts;state.alertsStatus=data.status;state.weatherMeta=data;renderAlerts();
}
async function refreshPrivate(){
  if(!state.user)return;
  try{
    if(state.user.role==='admin'){
      const [teams,users,metrics,assignments]=await Promise.all([api('/api/teams'),api('/api/admin/users'),api('/api/admin/metrics'),api('/api/assignments/mine')]);
      state.teams=teams.teams;state.users=users.users;state.metrics=metrics;state.assignments=assignments.assignments;renderAdmin();renderAssignments();
    }else if(state.user.role==='responder'){
      const [teams,assignments]=await Promise.all([api('/api/teams'),api('/api/assignments/mine')]);state.teams=teams.teams;state.assignments=assignments.assignments;renderAssignments();
    }
  }catch(e){toast('Unable to load team data: '+e.message,'error')}
}
async function refreshAll(){
  const results=await Promise.allSettled([fetchIncidents(),fetchAlerts(),refreshPrivate()]);
  if(results[0].status==='rejected')showConnectionError();
  if(results.some(r=>r.status==='rejected'))toast('Some information could not refresh. Check your connection and try again.','error');
}
function showConnectionError(){
  $('#connectionNotice').textContent='Reports could not refresh. Information on screen may be out of date. Use Refresh to try again.';
  $('#connectionNotice').hidden=false;
}
function fitReports(){
  if(!state.map)return;
  if(!state.filtered.length){state.map.setView([26.3683,-80.1289],9);return;}
  state.map.fitBounds(L.latLngBounds(state.filtered.map(i=>[i.lat,i.lon])),{padding:[55,85],maxZoom:14});
}

function filteredIncidents(){
  const q=$('#searchFilter').value.trim().toLowerCase(),category=$('#categoryFilter').value,status=$('#statusFilter').value,severity=$('#severityFilter').value;
  const onlyMine=$('#myReportsFilter').checked;
  const items=state.incidents.filter(i=>(!category||i.category===category)&&(!status||i.status===status)&&(!severity||i.severity===severity)&&(!onlyMine||myReportIds.has(i.id))&&(!q||[i.title,i.description,i.address,i.id].some(v=>String(v||'').toLowerCase().includes(q))));
  const rank={critical:0,high:1,moderate:2,low:3};
  return items.sort((a,b)=>{
    if($('#sortFilter').value==='priority'){
      const closed=i=>['resolved','rejected'].includes(i.status)?1:0;
      const difference=closed(a)-closed(b)||(rank[a.severity]??4)-(rank[b.severity]??4);
      if(difference)return difference;
    }
    return new Date(b.created_at)-new Date(a.created_at);
  });
}
function severityPill(i){return `<span class="pill severity-${escapeHtml(i.severity)}">${escapeHtml(i.severity)}</span>`;}
function renderIncidents(){
  state.filtered=filteredIncidents();$('#feedCount').textContent=state.filtered.length;
  const feed=$('#incidentFeed');
  feed.innerHTML=state.filtered.length?state.filtered.map(i=>`<button class="incident-item" data-open-id="${i.id}" type="button"><div class="incident-item-top">${severityPill(i)}<span class="status-tag">${escapeHtml(statusLabel(i.status))}</span></div><div class="incident-title">${escapeHtml(i.title)}</div><p class="incident-description">${escapeHtml(i.description)}</p><div class="incident-meta"><span>${escapeHtml(categories[i.category]||'Other')} · ${escapeHtml(i.address||'Pinned location')}</span><span>${shortDate(i.created_at)}</span></div></button>`).join(''):
  `<div class="empty-state"><strong>${state.incidents.length?'No matching reports.':'Your community starts here.'}</strong><br>${state.incidents.length?'Try another filter or clear your search.':'No incidents have been submitted yet. Add a factual report to help build the shared picture.'}</div>`;
  if(!state.map)return;
  state.markers?.clearLayers();
  for(const i of state.filtered){
    const severity=i.status==='resolved'||i.status==='rejected'?'resolved':i.severity;
    const marker=L.marker([i.lat,i.lon],{icon:L.divIcon({className:'',html:`<div class="map-pin ${severity}"><span>${symbols[i.category]||'!'}</span></div>`,iconSize:[38,38],iconAnchor:[20,36]})});
    marker.bindTooltip(escapeHtml(i.title),{direction:'top',offset:[0,-29]});
    marker.on('click',()=>openIncident(i.id));state.markers.addLayer(marker);
  }
}
function initializeMap(){
  if(state.map||typeof L==='undefined'){
    if(typeof L==='undefined')$('#incidentMap').innerHTML='<div class="map-load-error">Map library could not load. Check internet access or your network restrictions. Reports are still accessible in the list.</div>';
    return;
  }
  const initial=[26.3683,-80.1289];
  state.map=L.map('incidentMap',{zoomControl:true}).setView(initial,9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'}).addTo(state.map);
  state.markers=L.layerGroup().addTo(state.map);state.weatherLayer=L.geoJSON(null,{style:weatherStyle,onEachFeature:(feature,layer)=>{
    layer.bindPopup(`<strong>${escapeHtml(feature.properties.event)}</strong><p>${escapeHtml(feature.properties.headline)}</p><small>Official National Weather Service alert</small>`);
  }});
  state.mapReady=true;renderIncidents();renderAlerts();
}
function weatherStyle(feature){const s=feature.properties.severity;return {color:s==='Extreme'?'#c44341':s==='Severe'?'#e87549':'#e9ac54',weight:2,fillOpacity:.09,dashArray:'5 5'};}
function renderAlerts(){
  const meta=state.weatherMeta;
  $('#nwsMeta').textContent=!meta?'Loading official feed…':meta.status==='live'?`NWS ${meta.area} · ${state.alerts.length} current alerts · Updated ${shortDate(meta.fetchedAt)}`:'Official alert service unavailable; last attempt '+shortDate(meta.fetchedAt);
  const feed=$('#alertsFeed');
  if(meta?.status==='unavailable') feed.innerHTML='<div class="empty-state">Official weather alert feed is temporarily unavailable. Check <a href="https://www.weather.gov/" target="_blank" rel="noopener noreferrer">weather.gov ↗</a> directly.</div>';
  else if(!state.alerts.length)feed.innerHTML='<div class="empty-state">No active official alerts returned for the configured state. This does not guarantee safe conditions.</div>';
  else feed.innerHTML=state.alerts.slice(0,8).map(a=>`<article class="alert-card"><small>OFFICIAL NWS · ${escapeHtml(a.severity||'UNKNOWN')}</small><h3>${escapeHtml(a.event)}</h3><p>${escapeHtml(a.area)}</p><p>${escapeHtml(a.headline)}</p></article>`).join('');
  if(state.map&&state.weatherLayer){
    state.weatherLayer.clearLayers();
    if($('#alertsToggle').checked){
      for(const a of state.alerts)if(a.geometry){
        try{state.weatherLayer.addData({type:'Feature',properties:{event:a.event,headline:a.headline,severity:a.severity},geometry:a.geometry});}catch(e){console.warn('Skipped invalid alert shape',e);}
      }
      state.weatherLayer.addTo(state.map);
    }else if(state.map.hasLayer(state.weatherLayer))state.map.removeLayer(state.weatherLayer);
  }
}
function setReportPin(lat,lon){
  $('#reportLat').value=Number(lat).toFixed(6);$('#reportLon').value=Number(lon).toFixed(6);
  if(state.reportMap){
    if(state.reportMarker)state.reportMarker.setLatLng([lat,lon]);
    else state.reportMarker=L.marker([lat,lon],{draggable:true}).addTo(state.reportMap).on('dragend',ev=>{
      const p=ev.target.getLatLng();setReportPin(p.lat,p.lng);
    });
  }
}
function openReport(){
  requireLogin(()=>{
    formError('#reportError','');$('#reportForm').reset();$('#reportLat').value='';$('#reportLon').value='';
    if(state.reportMarker&&state.reportMap){state.reportMap.removeLayer(state.reportMarker);state.reportMarker=null;}
    openDialog('#reportDialog');
    setTimeout(()=>{
      if(typeof L==='undefined'){formError('#reportError','Map failed to load. You can enter latitude and longitude directly.');return;}
      if(!state.reportMap){
        const center=state.map?state.map.getCenter():{lat:26.3683,lng:-80.1289};
        state.reportMap=L.map('reportMap').setView([center.lat,center.lng],12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(state.reportMap);
        state.reportMap.on('click',e=>setReportPin(e.latlng.lat,e.latlng.lng));
      }
      state.reportMap.invalidateSize();
      if(state.map){const p=state.map.getCenter();state.reportMap.setView([p.lat,p.lng],state.map.getZoom()>13?13:state.map.getZoom());}
    },100);
  });
}
async function submitReport(e){
  e.preventDefault();const form=e.currentTarget,button=$('#reportSubmit');formError('#reportError','');
  const b=Object.fromEntries(new FormData(form).entries());b.lat=Number(b.lat);b.lon=Number(b.lon);
  loadingButton(button,true);
  try{
    const result=await api('/api/incidents',{method:'POST',body:b});closeDialog('#reportDialog');
    await fetchIncidents();location.hash='#map';
    setTimeout(()=>{state.map?.setView([result.incident.lat,result.incident.lon],14);openIncident(result.incident.id);},120);
    toast('Your report is now on the map and awaiting verification.');
  }catch(ex){formError('#reportError',ex.message)}finally{loadingButton(button,false,'Publish community report ↗');}
}
async function openIncident(ident){
  const content=$('#incidentDetailContent');content.innerHTML='<div class="empty-state">Loading report…</div>';
  openDialog('#incidentDialog');
  try{
    const data=await api('/api/incidents/'+encodeURIComponent(ident));const i=data.incident;
    state.selected=i;
    const navigate=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(i.lat+','+i.lon)}`;
    const teamOptions=state.teams.map(t=>`<option value="${t.id}" ${t.id===i.team_id?'selected':''}>${escapeHtml(t.name)} (${escapeHtml(t.availability)})</option>`).join('');
    const admin=state.user?.role==='admin';
    const updates=data.updates.map(u=>`<div class="update-item"><strong>${escapeHtml(statusLabel(u.action))} <small>· ${shortDate(u.created_at)}</small></strong><p>${escapeHtml(u.message)}</p><small>${escapeHtml(u.actor_role)} action</small></div>`).join('');
    content.innerHTML=`<div class="modal-kicker">INCIDENT RECORD / ${escapeHtml(i.id.slice(0,8).toUpperCase())}</div><h2 class="detail-title" id="detailHeading">${escapeHtml(i.title)}</h2><div class="detail-header">${severityPill(i)}<span class="status-tag">${escapeHtml(statusLabel(i.status))}</span><span class="status-tag">${escapeHtml(categories[i.category])}</span></div><p class="detail-body">${escapeHtml(i.description)}</p>
    <div class="detail-grid"><div class="detail-cell"><small>LOCATION</small><strong>${escapeHtml(i.address||'Coordinates pinned by reporter')}</strong></div><div class="detail-cell"><small>COORDINATES</small><strong>${formatCoordinate(i.lat)}, ${formatCoordinate(i.lon)}</strong></div><div class="detail-cell"><small>FIRST REPORTED</small><strong>${shortDate(i.created_at)}</strong></div><div class="detail-cell"><small>ASSIGNED TEAM</small><strong>${escapeHtml(i.team_name||'Not assigned')}</strong></div></div>
    <div class="detail-actions"><button type="button" class="button button-outline" id="centerIncident">⌖ Show on map</button><a class="button button-outline" href="${navigate}" rel="noopener noreferrer" target="_blank">↗ Open navigation</a><button type="button" class="button button-outline" id="copyCoordinates">Copy coordinates</button></div>
    ${admin?`<div class="admin-edit"><div class="detail-section-heading">COMMAND CENTER · REVIEW & DISPATCH</div><form id="incidentAdminForm"><div class="form-row"><label>Review status<select name="status">${['reported','verified','dispatched','in_progress','resolved','rejected'].map(s=>`<option value="${s}" ${s===i.status?'selected':''}>${escapeHtml(statusLabel(s))}</option>`).join('')}</select></label><label>Priority<select name="severity">${['low','moderate','high','critical'].map(s=>`<option value="${s}" ${s===i.severity?'selected':''}>${s}</option>`).join('')}</select></label></div><label>Assign a response team<select name="team_id"><option value="">No team assigned</option>${teamOptions}</select></label><label>Operational update (public log)<textarea name="note" maxlength="500" rows="2" placeholder="Describe verification or dispatch decision. Avoid sensitive details."></textarea></label><button class="button button-primary button-full" type="submit">Save and dispatch ↗</button><div class="form-error" id="adminIncidentError" role="alert" hidden></div></form>${i.team_id?`<button id="routeTeam" type="button" class="button button-outline button-full" style="margin-top:12px">↗ Show team-to-incident route</button>`:''}</div>`:''}
    <div class="detail-section-heading">INCIDENT HISTORY</div><div class="updates-feed">${updates||'<div class="empty-state">No updates recorded.</div>'}</div>`;
    $('#centerIncident').addEventListener('click',()=>{closeDialog('#incidentDialog');location.hash='#map';setTimeout(()=>{state.map?.setView([i.lat,i.lon],15);},110);});
    $('#copyCoordinates').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(`${i.lat}, ${i.lon}`);toast('Coordinates copied.');}catch{toast('Clipboard unavailable.','error');}});
    if(admin){$('#incidentAdminForm').addEventListener('submit',e=>submitAdminIncident(e,i.id));$('#routeTeam')?.addEventListener('click',()=>routeTeamToIncident(i));}
  }catch(e){content.innerHTML='<div class="empty-state">Could not load incident: '+escapeHtml(e.message)+'</div>';}
}
async function submitAdminIncident(e,ident){
  e.preventDefault();const form=e.currentTarget,b=Object.fromEntries(new FormData(form).entries());const btn=form.querySelector('[type=submit]');
  formError('#adminIncidentError','');loadingButton(btn,true);
  try{
    await api('/api/admin/incidents/'+ident,{method:'PATCH',body:b});
    await Promise.all([fetchIncidents(),refreshPrivate()]);
    toast('Report updated and team assignment saved.');await openIncident(ident);
  }catch(ex){formError('#adminIncidentError',ex.message)}finally{if(btn.isConnected)loadingButton(btn,false,'Save and dispatch ↗');}
}
async function routeTeamToIncident(i){
  const team=state.teams.find(t=>t.id===i.team_id);
  if(!team||team.base_lat==null||team.base_lon==null){toast('Add the team’s real base coordinates before routing.','error');return;}
  closeDialog('#incidentDialog');location.hash='#map';
  setTimeout(async()=>{
    if(!state.map){toast('The map is not available','error');return;}
    if(state.routeLayer){state.map.removeLayer(state.routeLayer);state.routeLayer=null;}
    if(state.routeMarkers){state.map.removeLayer(state.routeMarkers);state.routeMarkers=null;}
    const box=$('#routeInfo');box.hidden=false;box.innerHTML='<strong>Calculating road route…</strong>';
    try{
      const params=new URLSearchParams({from_lat:team.base_lat,from_lon:team.base_lon,to_lat:i.lat,to_lon:i.lon});
      const result=await api('/api/route?'+params);
      const line=result.coordinates.map(p=>[p[1],p[0]]);
      state.routeLayer=L.polyline(line,{color:'#008d78',weight:5,opacity:.85}).addTo(state.map);
      state.map.fitBounds(state.routeLayer.getBounds(),{padding:[60,60]});
      const km=(result.distance_m/1000).toFixed(1),minutes=Math.round(result.duration_s/60);
      box.innerHTML=`<strong>${escapeHtml(team.name)} → ${escapeHtml(i.title)}</strong>Estimated driving route: ${km} km · ~${minutes} min. Not flood-safe verified.<div><button id="clearRoute">Clear route ×</button></div>`;
    }catch(e){
      state.routeLayer=L.polyline([[team.base_lat,team.base_lon],[i.lat,i.lon]],{color:'#db9361',weight:3,dashArray:'7 7'}).addTo(state.map);
      state.map.fitBounds(state.routeLayer.getBounds(),{padding:[60,60]});
      box.innerHTML=`<strong>Road route not available.</strong>Orange dotted line is straight-line direction only—not a drivable route. Check road closures and official directions.<div><button id="clearRoute">Clear indication ×</button></div>`;
    }
    state.routeMarkers=L.layerGroup([L.marker([team.base_lat,team.base_lon]).bindTooltip(escapeHtml(team.name)+' base')]).addTo(state.map);
    $('#clearRoute')?.addEventListener('click',clearRoute);
  },150);
}
function clearRoute(){if(state.routeLayer)state.map.removeLayer(state.routeLayer);if(state.routeMarkers)state.map.removeLayer(state.routeMarkers);state.routeLayer=state.routeMarkers=null;$('#routeInfo').hidden=true;}
function renderAdmin(){
  if(state.user?.role!=='admin')return;
  const s=state.stats||{total:0};
  $('#adminTotal').textContent=s.total;
  $('#adminPending').textContent=state.incidents.filter(i=>i.status==='reported').length;
  $('#adminDispatch').textContent=state.incidents.filter(i=>['dispatched','in_progress'].includes(i.status)).length;
  $('#adminTeams').textContent=state.teams.length;
  const sorted=[...state.incidents].filter(i=>!['resolved','rejected'].includes(i.status)).sort((a,b)=>{
    const sev={critical:4,high:3,moderate:2,low:1};return sev[b.severity]-sev[a.severity] || a.created_at.localeCompare(b.created_at);
  });
  $('#adminQueue').innerHTML=sorted.length?sorted.slice(0,20).map(i=>`<div class="queue-item"><div class="queue-main"><div class="queue-top">${severityPill(i)}<span class="status-tag">${escapeHtml(statusLabel(i.status))}</span></div><strong>${escapeHtml(i.title)}</strong><small>${escapeHtml(i.address||formatCoordinate(i.lat)+', '+formatCoordinate(i.lon))} · ${shortDate(i.created_at)}</small></div><button type="button" data-open-id="${i.id}">Manage ↗</button></div>`).join(''):'<div class="empty-state">No active reports in the queue.</div>';
  const metrics=state.metrics||{byCategory:[],days:[]};
  const max=Math.max(1,...metrics.byCategory.map(x=>x.count));
  $('#categoryChart').innerHTML=metrics.byCategory.length?metrics.byCategory.map(v=>`<div class="bar-row"><span>${escapeHtml(categories[v.label]||v.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(v.count/max*100)}%"></div></div><strong>${v.count}</strong></div>`).join(''):'<div class="empty-state">No reports yet. Categories appear as submissions arrive.</div>';
  const days=[];
  for(let n=13;n>=0;n--){const d=new Date();d.setDate(d.getDate()-n);const date=d.toISOString().slice(0,10);days.push({day:date,count:metrics.days.find(v=>v.day===date)?.count||0});}
  const mx=Math.max(1,...days.map(x=>x.count));
  $('#activityChart').innerHTML=days.map(d=>`<div class="activity-day" title="${d.day}: ${d.count} reports"><div style="height:${Math.max(3,Math.round(d.count/mx*95))}%"></div><small>${d.day.slice(8)}</small></div>`).join('');
  $('#teamsList').innerHTML=state.teams.length?state.teams.map(t=>`<div class="team-card"><div><strong>${escapeHtml(t.name)}</strong><p>${escapeHtml(t.specialty)} · ${escapeHtml(t.lead_name||'No crew lead')}</p></div><div><span class="availability ${escapeHtml(t.availability)}">${escapeHtml(t.availability)}</span><button type="button" data-edit-team="${t.id}">Edit</button></div></div>`).join(''):'<div class="empty-state">No response teams created. Add a crew with a real location and registered lead.</div>';
  $('#userList').innerHTML=state.users.length?state.users.map(u=>`<div class="user-row"><div><strong>${escapeHtml(u.name)}${u.id===state.user.id?' (you)':''}</strong><small>${escapeHtml(u.email)}</small></div><select aria-label="Role for ${escapeHtml(u.name)}" data-user-role="${u.id}"><option value="resident" ${u.role==='resident'?'selected':''}>Resident</option><option value="responder" ${u.role==='responder'?'selected':''}>Responder</option><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option></select></div>`).join(''):'<div class="empty-state">No users</div>';
}
function openTeam(idValue=null){
  const team=idValue?state.teams.find(t=>t.id===idValue):null;
  const f=$('#teamForm');f.reset();$('#editTeamId').value=team?.id||'';
  $('#teamHeading').textContent=team?'Edit response team':'Create a response team';
  $('#teamSubmit').textContent=team?'Save changes':'Create response team';
  const leads=state.users.filter(u=>['responder','admin'].includes(u.role));
  $('#teamLead').innerHTML='<option value="">Unassigned (administrators only)</option>'+leads.map(u=>`<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.email)})</option>`).join('');
  if(team){for(const name of ['name','specialty','contact','base_lat','base_lon','lead_user_id','availability'])f.elements[name].value=team[name]??'';}
  formError('#teamError','');openDialog('#teamDialog');
}
async function submitTeam(e){
  e.preventDefault();const form=e.currentTarget,button=$('#teamSubmit');const b=Object.fromEntries(new FormData(form).entries()),ident=b.id;delete b.id;
  formError('#teamError','');loadingButton(button,true);
  try{
    await api(ident?'/api/admin/teams/'+ident:'/api/admin/teams',{method:ident?'PATCH':'POST',body:b});
    closeDialog('#teamDialog');await refreshPrivate();toast(ident?'Team updated.':'New response team created.');
  }catch(ex){formError('#teamError',ex.message)}finally{loadingButton(button,false,ident?'Save changes':'Create response team');}
}
async function updateRole(select){
  const ident=select.dataset.userRole,u=state.users.find(x=>x.id===ident),role=select.value;
  if(!u)return;
  if(!confirm(`Change ${u.name}'s role from ${u.role} to ${role}? This changes their access to disaster response operations.`)){select.value=u.role;return;}
  select.disabled=true;
  try{await api('/api/admin/users/'+ident,{method:'PATCH',body:{role}});await refreshPrivate();toast('Role updated.');
    if(ident===state.user.id){const me=await api('/api/auth/me');state.user=me.user;updateAuthUI();route();}
  }catch(e){select.value=u.role;toast(e.message,'error')}finally{select.disabled=false;}
}
function renderAssignments(){
  if(!['responder','admin'].includes(state.user?.role))return;
  const active=state.assignments.filter(a=>!['reassigned','cancelled'].includes(a.status));
  const html=active.map(a=>{
    const progress=['assigned','acknowledged','en_route','on_scene','completed'];
    const index=progress.indexOf(a.status);
    const next=progress[index+1];
    return `<article class="assignment-card"><div class="queue-top"><span class="pill severity-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</span><span class="status-tag">${escapeHtml(statusLabel(a.status))}</span></div><h2>${escapeHtml(a.title)}</h2><p>${escapeHtml(a.description)}</p><div class="job-meta"><span>TEAM: ${escapeHtml(a.team_name)}</span><span>${formatCoordinate(a.lat)}, ${formatCoordinate(a.lon)}</span><span>${escapeHtml(a.address||'Pinned coordinates')}</span></div><div class="job-actions"><button type="button" data-open-id="${a.incident_id}">Details & location ↗</button>${next?`<button type="button" data-progress-id="${a.id}" data-progress-status="${next}">Mark ${escapeHtml(statusLabel(next))}</button>`:'<button disabled>Completed ✓</button>'}</div></article>`;
  }).join('');
  $('#assignmentsList').innerHTML=html||'<div class="empty-state">No assignments yet. A response coordinator must assign a team to a report, and the team must have your account listed as lead.</div>';
}
async function updateAssignment(idValue,status){
  if(status==='completed'&&!confirm('Confirm that this incident has been resolved by the assigned response team?'))return;
  try{await api('/api/assignments/'+idValue,{method:'PATCH',body:{status}});await Promise.all([refreshPrivate(),fetchIncidents()]);toast('Response progress updated.');}
  catch(e){toast(e.message,'error')}
}
async function initialize(){
  $('#footerYear').textContent=new Date().getFullYear();
  $('.skip-link').addEventListener('click',e=>{e.preventDefault();$('#mainContent').focus();});
  $('#accountButton').addEventListener('click',()=>openAuth('login'));
  $('#signUpButton').addEventListener('click',()=>openAuth('register'));
  $('#logoutButton').addEventListener('click',logout);
  $('#loginTab').addEventListener('click',()=>openAuth('login'));
  $('#registerTab').addEventListener('click',()=>openAuth('register'));
  $('#authForm').addEventListener('submit',submitAuth);
  $$('#heroReport,#mapReport').forEach(b=>b.addEventListener('click',openReport));
  $('#reportForm').addEventListener('submit',submitReport);
  $('#useLocation').addEventListener('click',()=>{
    if(!navigator.geolocation){formError('#reportError','Geolocation not supported');return;}
    navigator.geolocation.getCurrentPosition(p=>{
      setReportPin(p.coords.latitude,p.coords.longitude);state.reportMap?.setView([p.coords.latitude,p.coords.longitude],15);
    },e=>formError('#reportError','Location denied or unavailable: '+e.message),{timeout:10000,enableHighAccuracy:true});
  });
  $$('#reportLat,#reportLon').forEach(el=>el.addEventListener('change',()=>{
    const lat=Number($('#reportLat').value),lon=Number($('#reportLon').value);
    if($('#reportLat').value&&$('#reportLon').value&&Math.abs(lat)<=90&&Math.abs(lon)<=180){setReportPin(lat,lon);state.reportMap?.panTo([lat,lon]);}
  }));
  $('#teamForm').addEventListener('submit',submitTeam);
  $$('#addTeam,#addTeamSecondary').forEach(b=>b.addEventListener('click',()=>openTeam()));
  $$('#refreshButton,#adminRefresh,#tasksRefresh').forEach(b=>b.addEventListener('click',refreshAll));
  $$('#categoryFilter,#statusFilter,#severityFilter,#sortFilter,#myReportsFilter').forEach(el=>el.addEventListener('change',renderIncidents));
  $('#searchFilter').addEventListener('input',()=>{clearTimeout(debounceTimer);debounceTimer=setTimeout(renderIncidents,170)});
  $('#clearFilters').addEventListener('click',()=>{$('#searchFilter').value='';$('#categoryFilter').value='';$('#statusFilter').value='';$('#severityFilter').value='';$('#sortFilter').value='priority';$('#myReportsFilter').checked=false;renderIncidents()});
  $('#alertsToggle').addEventListener('change',renderAlerts);
  $('#recenterButton').addEventListener('click',fitReports);
  $('#mobileMenu').addEventListener('click',()=>{const open=$('.nav-links').classList.toggle('open');$('#mobileMenu').setAttribute('aria-expanded',String(open));});
  $$('[data-close]').forEach(btn=>btn.addEventListener('click',()=>closeDialog('#'+btn.dataset.close)));
  $$('dialog').forEach(d=>d.addEventListener('click',e=>{
    if(e.target!==d)return;
    const box=d.getBoundingClientRect();
    if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)d.close();
  }));
  $('#authDialog').addEventListener('close',()=>{if(!state.user)pendingReport=false;});
  document.body.addEventListener('click',e=>{
    const op=e.target.closest('[data-open-id]');if(op){openIncident(op.dataset.openId);return;}
    const edit=e.target.closest('[data-edit-team]');if(edit){openTeam(edit.dataset.editTeam);return;}
    const prog=e.target.closest('[data-progress-id]');if(prog){updateAssignment(prog.dataset.progressId,prog.dataset.progressStatus);return;}
  });
  document.body.addEventListener('change',e=>{if(e.target.matches('[data-user-role]'))updateRole(e.target)});
  window.addEventListener('hashchange',route);
  try{const me=await api('/api/auth/me');state.user=me.user;}catch(e){console.warn('Auth check failed',e)}
  updateAuthUI();route();
  await refreshAll();
  route();
  try{
    const events=new EventSource('/api/stream');state.stream=events;
    events.onopen=()=>{$('#syncStatus').innerHTML='<span class="live-dot"></span> Live updates connected';$('#feedSyncStatus').textContent='● LIVE SYNC';};
    events.onerror=()=>{$('#syncStatus').textContent='Reconnecting updates…';$('#feedSyncStatus').textContent='RECONNECTING';};
    events.addEventListener('change',e=>{
      let message;try{message=JSON.parse(e.data);}catch{return;}
      pendingChanges.add(message.kind);clearTimeout(refreshTimer);
      refreshTimer=setTimeout(async()=>{
        const changes=new Set(pendingChanges);pendingChanges.clear();
        const jobs=[];
        if(changes.has('incidents'))jobs.push(fetchIncidents());
        if(changes.has('teams')||changes.has('assignments')||(changes.has('incidents')&&state.user))jobs.push(refreshPrivate());
        const results=await Promise.allSettled(jobs);
        if(results.some(r=>r.status==='rejected'))showConnectionError();
      },300);
    });
  }catch(e){console.warn('Live events unavailable',e)}
  setInterval(()=>{if(document.visibilityState==='visible')fetchIncidents().catch(showConnectionError);},60000);
  setInterval(()=>{if(document.visibilityState==='visible')fetchAlerts().catch(()=>{});},10*60000);
}
document.addEventListener('DOMContentLoaded',initialize);


