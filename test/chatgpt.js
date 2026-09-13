const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path');
const {connectorFixture}=require('./chatgpt-fixture.cjs'),{fixture}=require('./member-fixture');
(async()=>{
 const c=await connectorFixture();let f;
 try{
  f=await fixture({publicAccess:true,chatgpt:{url:c.url,token:c.token},providerRequest:()=>{throw Error('API billing must never be used for ChatGPT');}});
  const a='user_customerA',b='user_customerB',opts=user=>({user});
  assert.equal((await c.request(a,'status',undefined,{authorization:'Bearer invalid'})).status,401);
  assert.equal((await c.request(a,'status',undefined,{origin:'https://evil.test'})).status,401);
  assert.equal((await fetch(f.base+'/api/ai/chatgpt')).status,401);
  assert.equal((await f.api('/api/ai/chatgpt',opts(a))).connected,false);
  assert.equal((await f.request('/api/ai/chatgpt/activate',{user:a,method:'POST',body:{user_id:b}})).status,401);
  const pending=await f.api('/api/ai/chatgpt/login',{user:a,method:'POST',body:{user_id:b}});
  assert.equal(pending.pending.verification_url,'https://auth.openai.com/codex/device');
  assert.equal((await f.api('/api/ai/chatgpt',opts(b))).pending,null);
  await f.api('/api/ai/chatgpt/cancel',{user:a,method:'POST'});assert.equal((await f.api('/api/ai/chatgpt',opts(a))).pending,null);
  await f.api('/api/ai/chatgpt/login',{user:a,method:'POST'});await c.approve(a,'a@example.com');
  await f.api('/api/ai/chatgpt/activate',{user:a,method:'POST'});
  await f.api('/api/ai/chatgpt/login',{user:b,method:'POST'});await c.approve(b,'b@example.com');await f.api('/api/ai/chatgpt/activate',{user:b,method:'POST'});
  const checks=await Promise.all([a,b].map(user=>f.api('/api/ai/chatgpt/test',{user,method:'POST'})));
  assert.ok(checks[0].reply.includes('a@example.com'));assert.ok(checks[1].reply.includes('b@example.com'));assert.ok(checks.every(x=>x.verified_at));assert.ok(!JSON.stringify(checks).includes('NEVER-RETURN'));
  const project=await f.project('Customer company','Customer project',a),second=await f.project('Other company','Other project',b);
  const thread=await f.api(`/api/boards/${project.project.id}/chat/threads`,{user:a,method:'POST',body:{}});
  async function waitJob(){let r;for(let i=0;i<200;i++){r=await f.api(`/api/chat/threads/${thread.id}`,opts(a));if(r.job&&!['queued','running'].includes(r.job.status))return r;await new Promise(r=>setTimeout(r,20));}throw Error('Chat job timed out');}
  for(const mode of ['ask','plan','work']){
   await f.api(`/api/chat/threads/${thread.id}/messages`,{user:a,method:'POST',body:{mode,content:mode==='work'?'Create the authorized task':'Summarize this project'}});
   const r=await waitJob();assert.equal(r.job.status,'completed',JSON.stringify(r.job));assert.ok(r.messages.at(-1).content.includes('a@example.com'));
  }
  const own=await f.api('/api/boards/'+project.project.id,opts(a)),other=await f.api('/api/boards/'+second.project.id,opts(b));
  assert.equal(own.lists.flatMap(l=>l.cards).filter(x=>x.title==='ChatGPT customer task').length,1);assert.equal(other.lists.flatMap(l=>l.cards).length,0);
  assert.equal((await f.api('/api/chat/status',opts(a))).funding,'owner_chatgpt');
  assert.equal((await f.api('/api/ai/settings',opts(a))).mode,'chatgpt');
  const aiDb=new Database(path.join(f.root,'personal-ai.db'),{readonly:true});assert.equal(aiDb.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);assert.equal(aiDb.prepare('SELECT COUNT(*) n FROM ai_usage').get().n,0);aiDb.close();
  // Shared company work uses the sponsoring owner's connection; personal
  // connection endpoints still belong to the signed-in actor.
  f.users.push({id:a,emailAddresses:[{emailAddress:'a@example.com',verification:{status:'verified'}}]});
  const shared=await f.project('Sponsored company','Shared project');
  await f.api(`/api/companies/${shared.company.id}/members`,{method:'POST',body:{email:'a@example.com',role:'editor'}});
  await f.api('/api/ai/chatgpt/login',{method:'POST'});await c.approve('user_owner','sponsor@example.com');await f.api('/api/ai/chatgpt/activate',{method:'POST'});
  const sharedOptions={user:a,workspace:'user_owner'};
  assert.equal((await f.api('/api/ai/chatgpt',sharedOptions)).email,'a@example.com');
  const teamThread=await f.api(`/api/boards/${shared.project.id}/chat/threads`,{...sharedOptions,method:'POST',body:{}});
  await f.api(`/api/chat/threads/${teamThread.id}/messages`,{...sharedOptions,method:'POST',body:{mode:'ask',content:'Summarize the shared project'}});
  let teamReply;for(let i=0;i<100;i++){teamReply=await f.api(`/api/chat/threads/${teamThread.id}`,sharedOptions);if(teamReply.job.status==='completed')break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(teamReply.job.status,'completed');assert.match(teamReply.messages.at(-1).content,/sponsor@example.com/);
  // Account-scoped onboarding persists across workspace/session changes, and a
  // request body cannot change the identity whose progress is stored.
  assert.equal((await f.api('/api/onboarding',opts(a))).status,'new');
  await f.api('/api/onboarding',{user:a,method:'PUT',body:{step:2,status:'started',user_id:b}});
  assert.equal((await f.api('/api/onboarding',opts(a))).step,2);assert.equal((await f.api('/api/onboarding',opts(b))).status,'new');
  assert.equal((await f.request('/api/onboarding',{user:a,method:'PUT',body:{step:99,status:'completed'}})).status,400);
  await f.api('/api/onboarding',{user:a,method:'PUT',body:{step:4,status:'completed'}});assert.equal((await f.api('/api/onboarding',opts(a))).status,'completed');
  const payload=text=>({model:'gpt-6-astra',input:[{role:'user',content:text}],tools:[]});
  assert.equal((await c.request(a,'respond',payload('unavailable-tool'))).status,502);
  const limited=await c.request(a,'respond',payload('simulate-rate-limit'));assert.equal(limited.status,502);assert.match((await limited.json()).error,/usage limit/);
  // Disconnect one account while a generation is running. Neither its result
  // nor refreshed credentials may survive, and the other account stays usable.
  const slow=c.request(a,'respond',payload('slow-response'));await new Promise(r=>setTimeout(r,100));
  const disconnect=f.api('/api/ai/chatgpt/disconnect',{user:a,method:'POST'}),during=f.api('/api/ai/chatgpt',opts(a));
  assert.equal((await slow).status,401);await disconnect;assert.equal((await during).connected,false);
  assert.equal((await f.api('/api/ai/settings',opts(a))).mode,'none');assert.equal((await f.api('/api/ai/chatgpt',opts(a))).connected,false);
  assert.equal((await f.api('/api/ai/chatgpt',opts(b))).connected,true);
  assert.equal((await f.request(`/api/chat/threads/${thread.id}/messages`,{user:a,method:'POST',body:{mode:'work',content:'Do not borrow the sponsor connection'}})).status,402);
  assert.equal((await f.api('/api/ai/chatgpt')).email,'sponsor@example.com','Customer disconnect leaves the platform owner connection untouched');
  console.log('PASS: real process protocol harness, private service, independent customer logins, cancel/test/disconnect race, Ask/Plan/Work with scoped task actions, zero API charges, rate-limit errors and per-user onboarding persistence');
 }finally{if(f)await f.close();await c.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
