const assert=require('node:assert/strict'),crypto=require('node:crypto'),Database=require('better-sqlite3'),path=require('node:path');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
(async()=>{
 let sent=[],updates=[],hold,entered,block=false;
 const token='bot-private-company-key-12345';
 const fake=async(provider,key,method,body)=>{assert.equal(key,token);if(method==='users/@me')return{id:'11111111',username:'Boardly helper',bot:true};if(method==='getMe')return{id:22222222,username:'boardly_test_bot',first_name:'Helper',is_bot:true};if(method==='getWebhookInfo')return{url:''};if(method==='users/@me/guilds')return[{id:'33333333',name:'My server'}];if(method==='guilds/33333333/channels')return[{id:'44444444',name:'updates',type:0},{id:'55555555',name:'Voice',type:2}];if(method==='channels/44444444')return{id:'44444444',name:'updates',type:0};if(method==='getUpdates')return updates;if(method.endsWith('/messages')||method==='sendMessage'){sent.push(body);if(block){entered=true;await new Promise(r=>hold=r);}return provider==='discord'?{id:'receipt'}:{message_id:1};}throw Error('Unexpected method '+method);};
 const f=await fixture({botRequest:fake});
 try{
  const a=await f.project('Company A','Project A'),b=await f.project('Company B','Project B');const route=(id,p='discord')=>`/api/companies/${id}/bots/${p}`,r=route(a.company.id);
  let state=await f.api(r,{method:'PUT',body:{token}});assert.equal(state.saved,true);assert.ok(!JSON.stringify(state).includes(token));assert.equal(sent.length,0);
  assert.deepEqual(await f.api(r+'/destinations'),[{id:'33333333',name:'My server'}]);assert.equal((await f.api(r+'/destinations?guild=33333333')).length,1);
  assert.equal((await f.request(r+'/destination',{method:'PUT',body:{id:'../evil'}})).status,400);
  await f.api(r+'/destination',{method:'PUT',body:{id:'44444444'}});
  const id=crypto.randomUUID();await Promise.all([f.api(r+'/send',{method:'POST',body:{request_id:id,test:true}}),f.api(r+'/send',{method:'POST',body:{request_id:id,test:true}})]);assert.equal(sent.length,1);assert.deepEqual(sent[0].allowed_mentions,{parse:[]});
  assert.equal((await f.request(r+'/preview',{method:'POST',body:{project_id:b.project.id}})).status,404);
  const preview=await f.api(r+'/preview',{method:'POST',body:{project_id:a.project.id}});assert.match(preview.text,/Project A/);assert.equal((await f.request(r+'/send',{method:'POST',body:{request_id:crypto.randomUUID(),project_id:a.project.id,preview:'stale'}})).status,409);
  await f.api(r+'/send',{method:'POST',body:{request_id:crypto.randomUUID(),project_id:a.project.id,preview:preview.text}});assert.equal(sent.length,2);
  const member=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'bot-member@test.example'}})).member.user_id;assert.equal((await f.request(r,{user:member,workspace:'user_owner'})).status,403);assert.equal((await f.api(route(b.company.id))).saved,false);
  const tr=route(a.company.id,'telegram');await f.api(tr,{method:'PUT',body:{token}});const pair=await f.api(tr+'/pair',{method:'POST',body:{}});const code=new URL(pair.pairing_url).searchParams.get('start');assert.ok(code);assert.equal((await f.request(tr+'/check',{method:'POST',body:{}})).status,409);
  updates=[{message:{chat:{id:99999999,type:'private',first_name:'Ben'},text:'/start '+code,date:Math.floor(Date.now()/1000)+1}}];state=await f.api(tr+'/check',{method:'POST',body:{}});assert.equal(state.destination,'99999999');assert.equal(state.pairing_url,null);
  await f.api(tr+'/send',{method:'POST',body:{request_id:crypto.randomUUID(),test:true}});assert.equal(sent.at(-1).chat_id,'99999999');
  const db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'),{readonly:true});assert.ok(!JSON.stringify(db.prepare('SELECT * FROM company_bots').all()).includes(token));db.close();
  await f.api(tr,{method:'DELETE'});assert.equal((await f.request(tr+'/send',{method:'POST',body:{request_id:crypto.randomUUID(),test:true}})).status,400);
  console.log('PASS: bot identity, encrypted tokens, company/member isolation, server/channel selection, Telegram pairing, explicit test and previewed update sends, replay prevention and disconnect');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
