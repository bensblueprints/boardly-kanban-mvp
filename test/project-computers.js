const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
(async()=>{
 const desktop_id=crypto.randomUUID(),data={id:'fixture-account',rentals:[],desktops:[{id:desktop_id,kind:'pilot',state:'active',available:true,memory_mib:6144,label:'ThinkCentre 8 GB'}]};
 const f=await fixture({publicAccess:true,computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async()=>data});let db;
 try{
  const a=await f.project('Company A','Project A'),b=await f.project('Company B','Project B'),route=`/api/boards/${a.project.id}/computers`;
  let state=await f.api(route);assert.equal(state.source,'computeruse_api');assert.equal(state.plan,null);assert.equal(state.available_computers,0);assert.equal(state.can_request,false);assert.equal(state.checkout_available,false);
  await f.api('/api/account/computeruse',{method:'PUT',body:{token:'cu_fixture_account_key_123456'}});
  for(const p of [a,b])assert.equal((await f.api(`/api/companies/${p.company.id}/computeruse/rentals`)).rentals.length,1);
  await f.api(`/api/companies/${a.company.id}/computeruse`,{method:'PUT',body:{rental_ids:['desktop:'+desktop_id],allow_agent:true,allow_control:true}});
  state=await f.api(route);assert.equal(state.available_computers,1);assert.equal(state.computers[0].desktop_id,desktop_id);assert.equal(state.assignment.inherited,true);assert.equal(state.company_id,a.company.id);assert.ok(!JSON.stringify(state).includes('2999'));
  assert.equal((await f.api(`/api/boards/${b.project.id}/computers`)).available_computers,0);
  for(const suffix of ['/request','/checkout'])assert.equal((await f.request(route+suffix,{method:suffix==='/request'?'PUT':'POST',body:{quantity:2,paid:true}})).status,410);
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));assert.equal(db.prepare('SELECT COUNT(*) n FROM project_computer_requests').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_jobs').get().n,0);
  const member=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'computer-member@example.com',role:'editor'}})).member;
  const options={user:member.user_id,workspace:'user_owner'};assert.equal((await f.request(route,options)).status,403);
  const grant=(await f.api(`/api/projects/${a.project.id}/members`)).members.find(m=>m.email==='computer-member@example.com').grant_id;
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['computers']}});assert.equal((await f.api(route,options)).available_computers,1);
  assert.equal((await f.request(`/api/boards/${b.project.id}/computers`,options)).status,404);
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:[]}});assert.equal((await f.request(route,options)).status,403);
  data.desktops[0].available=false;assert.equal((await f.api(route)).available_computers,0);
  await f.api('/api/account/computeruse',{method:'DELETE'});state=await f.api(route);assert.equal(state.launch_status,'not_connected');assert.deepEqual(state.computers,[]);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  console.log('PASS: connected API inventory across companies, per-company assignment/inheritance, no stale price or checkout, no purchases/jobs, live availability and member isolation/revocation');
 }finally{db?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
