const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud'),{createComputerUseConnections,trustedOrigin}=require('../server/computeruse-connections');
const keyA='cu_test_account_a_key_only_123456',keyB='cu_test_account_b_key_only_654321';
const rental=(id,state='active',plan='standard')=>({id,state,plan,term:'30_days',period_end:1900000000,host_password:'never-show',machine_id:'private-machine'});
(async()=>{
 const watchdog=setTimeout(()=>{console.error('Timed out');process.exit(1)},60000);
 for(const origin of ['http://localhost','https://u:p@example.com','https://api.example.com/path'])assert.throws(()=>trustedOrigin(origin));
 const accounts=new Map([[keyA,{id:'acct-a',rentals:[rental('a'),rental('b','active','creator'),rental('inactive','suspended')],email:'private@example.test',balance_minor:10000}],[keyB,{id:'acct-b',rentals:[rental('other')]}]]);
 let wait=false,started,release;const request=async(origin,key)=>{assert.equal(origin,'https://api.computeruse.example');if(wait){started();await new Promise(r=>release=r)}return accounts.get(key)};
 const f=await fixture({publicAccess:true,computeruseOrigin:'https://api.computeruse.example',computeruseRequest:request});let db;
 try{
  const a=await f.project('A','One'),b=await f.project('B','Two'),base='/api/account/computeruse',company=`/api/companies/${a.company.id}/computeruse`,project=`/api/projects/${a.project.id}/computeruse`,other=`/api/projects/${b.project.id}/computeruse`;
  assert.equal((await f.api(base)).saved,false);await f.api(base,{method:'PUT',body:{token:keyA,origin:'https://attacker.test'}});
  const rentals=await f.api(base+'/rentals');assert.deepEqual(rentals.rentals.map(r=>r.id),['a','b','inactive']);assert.ok(!JSON.stringify(rentals).includes('never-show'));assert.ok(!JSON.stringify(rentals).includes('private@'));
  for(const rental_ids of [['other'],['inactive'],['a','a']])assert.ok([400,403].includes((await f.request(company,{method:'PUT',body:{rental_ids,allow_agent:true}})).status));
  await f.api(company,{method:'PUT',body:{rental_ids:['a','b'],allow_agent:true}});let s=await f.api(project);assert.equal(s.inherited,true);assert.deepEqual(s.rental_ids,['a','b']);assert.deepEqual((await f.api(other)).rental_ids,[]);
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM cu_account_connection').all()).includes(keyA));
  const service=createComputerUseConnections({db,key:fs.readFileSync(path.join(f.root,'project-secrets.key')),namespace:'user_owner',origin:'https://api.computeruse.example',request});
  assert.equal((await service.inspectForAgent(a.project.id,'user_owner')).rentals.length,2);
  await f.api(project,{method:'PUT',body:{rental_ids:[],allow_agent:false}});assert.equal((await f.api(project)).inherited,false);assert.equal(service.enabled(a.project.id),false);
  await f.api(project,{method:'DELETE'});assert.equal(service.enabled(a.project.id),true);
  accounts.get(keyA).rentals[0].state='suspended';await assert.rejects(()=>service.inspectForAgent(a.project.id,'user_owner'),/no longer active/);accounts.get(keyA).rentals[0].state='active';
  const member=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'computer-member@example.test',role:'editor'}})).member;
  member.grant_id=(await f.api(`/api/projects/${a.project.id}/members`)).members.find(m=>m.email==='computer-member@example.test').grant_id;
  const options={user:member.user_id,workspace:'user_owner'};
  assert.equal((await f.request(project,options)).status,403);assert.equal((await f.request(base,options)).status,403);
  await f.api(`/api/memberships/${member.grant_id}`,{method:'PATCH',body:{scopes:['computers']}});
  assert.equal((await f.api(project,options)).inherited,true);assert.equal((await f.request(other,options)).status,404);
  await f.api(project,{...options,method:'PUT',body:{rental_ids:['b'],allow_agent:false}});assert.deepEqual((await f.api(project)).rental_ids,['b']);
  // Revocation during provider I/O prevents assignment.
  wait=true;let signal=new Promise(r=>started=r);const pending=f.request(project,{...options,method:'PUT',body:{rental_ids:['a'],allow_agent:true}});await signal;await f.api(`/api/memberships/${member.grant_id}`,{method:'PATCH',body:{scopes:[]}});release();assert.equal((await pending).status,403);wait=false;
  // Disconnect wins over a pending account replacement.
  wait=true;signal=new Promise(r=>started=r);const connect=f.request(base,{method:'PUT',body:{token:keyB}});await signal;await f.api(base,{method:'DELETE'});release();assert.equal((await connect).status,409);wait=false;assert.equal((await f.api(base)).saved,false);assert.deepEqual((await f.api(project)).rental_ids,[]);
  // Reparenting while an inherited rental is verified must not attach across companies.
  await f.api(base,{method:'PUT',body:{token:keyA}});await f.api(company,{method:'PUT',body:{rental_ids:['a'],allow_agent:true}});
  wait=true;signal=new Promise(r=>started=r);const moving=f.request(project,{method:'PUT',body:{rental_ids:['b'],allow_agent:true}});await signal;await f.api(`/api/company-boards/${a.board.id}`,{method:'PATCH',body:{company_id:b.company.id}});release();assert.equal((await moving).status,409);wait=false;assert.deepEqual((await f.api(project)).rental_ids,[]);
  // Account A's encrypted key cannot be replayed in a different tenant.
  const otherTenant=await f.project('Other tenant','Private','user_other');assert.equal((await f.api(base,{user:'user_other'})).saved,false);
  const wrongNamespace=createComputerUseConnections({db,key:fs.readFileSync(path.join(f.root,'project-secrets.key')),namespace:'user_other',origin:'https://api.computeruse.example',request});await assert.rejects(()=>wrongNamespace.rentals(),/Reconnect/);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_jobs').get().n,0);
  console.log('PASS: account encryption, multi-computer assignment, company inheritance, project disable/override, active ownership, explicit member scopes, tenant isolation, membership/disconnect/reparent races and no purchase side effects');
 }finally{release?.();db?.close();f.server.closeAllConnections();await f.close();clearTimeout(watchdog)}
})().catch(e=>{console.error(e);process.exitCode=1});
