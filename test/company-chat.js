const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
const {workspacePath}=require('../server/cloud');
const {createCompanyChat}=require('../server/company-chat');
const Database=require('better-sqlite3'),path=require('node:path');
(async()=>{
 const f=await fixture({publicAccess:true});
 try{
  const a=await f.project('Clothing Company','Nasdo'),b=await f.project('Other company','Private');
  const card=await f.api(`/api/lists/${a.list.id}/cards`,{method:'POST',body:{title:'Prepare shirts'}});
  const viewer=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'viewer@example.com',role:'viewer'}})).member.user_id;
  const guest=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'guest@example.com'}})).member.user_id;
  const endpoint=`/api/companies/${a.company.id}/team-chat`,inside=`/api/cards/${card.id}/team-chat`;
  const post=(url,body,options={})=>f.api(url,{method:'POST',body:{client_id:crypto.randomUUID(),body,...options.payload},...options});
  const one=await post(endpoint,'Hello team');
  const memberOpts={user:viewer,workspace:'user_owner'};
  const two=await post(inside,'Working on this task',{...memberOpts,payload:{sender_name:'Company owner',company_id:b.company.id}});
  assert.equal(two.sender_name,'viewer@example.com');assert.equal(two.task.id,card.id);
  assert.deepEqual((await f.api(endpoint,memberOpts)).messages.map(m=>m.id),[one.id,two.id]);
  assert.equal((await f.api(inside)).company.id,a.company.id);
  const duplicate={client_id:crypto.randomUUID(),body:'Only once'};
  const dupe1=await f.api(endpoint,{method:'POST',body:duplicate}),dupe2=await f.api(endpoint,{method:'POST',body:duplicate});assert.equal(dupe1.id,dupe2.id);
  for(const url of [endpoint,inside,`/api/companies/${b.company.id}/team-chat`])assert.ok([403,404].includes((await f.request(url,{user:guest,workspace:'user_owner'})).status));
  assert.equal((await f.request(`/api/companies/${b.company.id}/team-chat`,memberOpts)).status,403);
  assert.equal((await f.request(endpoint,{...memberOpts,method:'DELETE'})).status,405);
  assert.equal((await f.request(endpoint,{method:'POST',body:{client_id:crypto.randomUUID(),body:' '}})).status,400);
  assert.equal((await f.request(endpoint+'?before=bad')).status,400);
  // A member's personal workspace has a separate company and history even when IDs collide.
  const own=await f.project('Member company','Own',viewer);
  assert.equal((await f.api(`/api/companies/${own.company.id}/team-chat`,{user:viewer})).messages.length,0);
  for(let i=0;i<105;i++)await post(endpoint,'History '+i);
  const recent=await f.api(endpoint);assert.equal(recent.messages.length,100);assert.equal(recent.has_more,true);
  const earlier=await f.api(endpoint+'?before='+recent.messages[0].id);assert.equal(earlier.messages.length,8);
  const after=await f.api(endpoint+'?after='+one.id);assert.equal(after.messages[0].id,two.id);assert.equal(after.has_more,true);
  // Persistence is in the authoritative tenant DB, including a fresh module/connection.
  const db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  createCompanyChat(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM company_messages WHERE company_id=?').get(a.company.id).n,108);db.close();
  await f.api(`/api/cards/${card.id}/move`,{method:'POST',body:{list_id:b.list.id,position:0}});
  assert.equal((await f.api(endpoint)).messages.find(m=>m.id===two.id),undefined); // paginated out
  assert.equal((await f.api(endpoint+'?before='+recent.messages[0].id)).messages.find(m=>m.id===two.id).task,null);
  assert.equal((await f.request(inside,memberOpts)).status,404);
  const grant=(await f.api(`/api/companies/${a.company.id}/members`)).members[0].grant_id;
  await f.api(`/api/memberships/${grant}`,{method:'DELETE'});
  assert.ok([403,404].includes((await f.request(endpoint,memberOpts)).status));
  assert.ok([403,404].includes((await f.request(endpoint,{...memberOpts,method:'POST',body:duplicate})).status));
  console.log('PASS: durable company/team/task chat, verified senders, Viewer participation, pagination, retry deduplication, tenant isolation, task moves and revocation');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
