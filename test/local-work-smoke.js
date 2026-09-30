// Opt-in: real local inference, isolated Boardly database and in-memory GitHub.
// No credentials, production cards, or real repository writes reach the model.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const {payloadFor,outputFor}=require('../server/ai-providers');
const endpoint=process.env.BOARDLY_TEST_LOCAL_URL;
if(!endpoint)throw Error('Set BOARDLY_TEST_LOCAL_URL to an authorized local model endpoint');
(async()=>{
 const remote=githubFixture();let turns=0;const initial=remote.head;
 const f=await fixture({githubRequest:remote.request,providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  if(++turns>8)throw Object.assign(Error('Smoke test exceeded eight model turns'),{status:400});
  const body=payloadFor({provider:'local',model:'huihui_ai/qwen3-coder-next-abliterated:latest'},JSON.parse(opts.body));
  const res=await fetch(endpoint+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,temperature:0,stream:false}),signal:AbortSignal.timeout(240000)});
  assert.ok(res.ok,'Local model HTTP '+res.status);const data=await res.json(),{output}=outputFor('local',data);
  console.log('Model turn '+turns+': '+output.map(x=>x.name||x.type).join(', '));
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',usage:{input_tokens:100,output_tokens:30},output});
 }});
 try{
  const p=await f.project('Isolated smoke test','Arithmetic app');
  await f.api(`/api/projects/${p.project.id}/github`,{method:'PUT',body:{repository:'northstar/website',branch:'main',token:'github_pat_fixture_'+crypto.randomBytes(24).toString('hex'),allow_agent:true}});
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});
  await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Implement the app function in src/app.js: CommonJS export add(a,b) returning the arithmetic sum. Read the existing file, then use github_commit_files to commit the actual source change. This is an isolated repository test with no SSH connection; verification will be run by the harness. Do not create tasks or planning documents. Report the resulting SHA and honestly state that you did not execute tests.'}});
  let h;const deadline=Date.now()+600000;
  while(Date.now()<deadline){h=await f.api(`/api/chat/threads/${t.id}`);if(!['queued','running'].includes(h.job.status))break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(h.job.status,'completed',JSON.stringify(h.job));assert.notEqual(remote.head,initial);
  const file=remote.trees.get(remote.commits.get(remote.head).tree.sha)['src/app.js'];const code=remote.blobs.get(file.sha).toString();
  const sandbox={module:{exports:{}},exports:{}};sandbox.exports=sandbox.module.exports;vm.runInNewContext(code,sandbox,{timeout:1000});
  const add=typeof sandbox.module.exports==='function'?sandbox.module.exports:sandbox.module.exports.add;
  assert.equal(add(2,3),5);assert.equal(add(-4,7),3);assert.equal(add(0,0),0);
  console.log(JSON.stringify({passed:true,model_turns:turns,commit:remote.head,changed_file:'src/app.js',assertions:3,production_writes:0}));
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
