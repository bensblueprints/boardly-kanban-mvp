const assert=require('node:assert/strict'),{fixture}=require('./member-fixture');
(async()=>{
 const calls=[];let offline=false,empty=false,pause=false,release,entered;
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'model-fast'},{id:'model-reasoning'}]});
  const body=JSON.parse(options.body);calls.push({url,body,key:options.headers.Authorization});
  assert.equal(body.messages.length,1);assert.equal(body.messages[0].content[0].text,'Connection test. Reply with only OK.');
  assert.equal(body.tools,undefined);assert.equal(body.max_tokens,512);assert.deepEqual(body.thinking,{type:'disabled'});
  if(pause){entered?.();await new Promise(r=>release=r);}
  if(offline)return Response.json({error:{message:'secret-provider-error'}},{status:503});
  return Response.json({choices:[{message:empty?{content:null,tool_calls:[{id:'x',function:{name:'do_not_run',arguments:'{}'}}]}:{content:'OK',reasoning_content:'hidden reasoning'}}],usage:{prompt_tokens:10,completion_tokens:1}});
 }});
 try{
  const p=await f.project('Ping company','Ping board'),route=`/api/companies/${p.company.id}/ai`;
  await f.api('/api/account/ai-providers/deepseek',{method:'PUT',body:{token:'organization-probe-key'}});
  await f.api('/api/account/ai-providers/deepseek/activate',{method:'POST'});
  await f.api(route+'/providers/deepseek',{method:'PUT',body:{token:'company-probe-key'}});
  const before=await f.api(route),aiBefore=await f.api('/api/ai/settings'),threadsBefore=await f.api(`/api/boards/${p.project.id}/chat/threads`);
  const probe=body=>f.api(route+'/test',{method:'POST',body});
  const selected={source:'company',provider:'deepseek',model:'model-reasoning'};
  const result=await probe({...selected,prompt:'Do work',tools:['do_work'],token:'ignored-key'});
  assert.equal(result.ok,true);assert.equal(result.reply,'OK');assert.equal(result.model,'model-reasoning');assert.ok(result.latency_ms>=0);assert.ok(result.tested_at>0);
  assert.equal(calls.at(-1).key,'Bearer company-probe-key');assert.equal(calls.at(-1).body.model,'model-reasoning');assert.ok(!JSON.stringify(result).includes('hidden reasoning'));
  assert.deepEqual((await f.api(route)).policy,before.policy,'Test does not save the draft selection');
  assert.equal((await f.api('/api/ai/settings')).model,aiBefore.model);assert.deepEqual(await f.api(`/api/boards/${p.project.id}/chat/threads`),threadsBefore,'Ping does not create agent jobs');
  const inherited=await probe({source:'inherit'});assert.equal(inherited.ok,true);assert.equal(inherited.model,'model-fast');assert.equal(calls.at(-1).key,'Bearer organization-probe-key');
  await probe({...selected,source:'organization'});assert.equal(calls.at(-1).key,'Bearer organization-probe-key');
  const account=await f.api('/api/account/ai-providers/deepseek/test',{method:'POST',body:{model:'model-reasoning'}});assert.equal(account.ok,true);assert.equal((await f.api('/api/ai/settings')).model,'model-fast');
  const n=calls.length;assert.equal((await probe({...selected,model:'not-listed'})).ok,false);assert.equal(calls.length,n,'Unlisted models are rejected before inference');
  offline=true;const failed=await probe(selected);assert.equal(failed.ok,false);assert.ok(!failed.error.includes('secret-provider-error'));assert.equal(calls.length,n+1,'Failed tests do not retry or fall back');offline=false;
  empty=true;assert.match((await probe(selected)).error,/without a text reply/);empty=false;
  const member=(await f.api(`/api/companies/${p.company.id}/members`,{method:'POST',body:{email:'ping-member@example.com'}})).member.user_id;
  assert.equal((await f.request(route+'/test',{user:member,workspace:'user_owner',method:'POST',body:selected})).status,403);
  assert.equal((await f.request(route+'/test',{user:'user_foreign',method:'POST',body:selected})).status,404);
  pause=true;const started=new Promise(r=>entered=r),pending=probe(selected);await started;
  assert.equal((await f.request(route+'/test',{method:'POST',body:selected})).status,409,'One test at a time');
  await f.api(route+'/providers/deepseek',{method:'PUT',body:{token:'replaced-key'}});pause=false;release();assert.equal((await pending).ok,false,'Credential changes invalidate in-flight tests');
  console.log('PASS: actual selected-model ping; unsaved selections; scoped credentials; inherited AI; no tools/jobs/settings changes; visible reply and timing; errors without fallback/retry; owner isolation; concurrency and revocation.');
 }finally{release?.();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
