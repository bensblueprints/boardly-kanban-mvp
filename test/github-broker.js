const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const {createGithubBroker}=require('../scripts/github-broker.cjs');
(async()=>{
 const remote=githubFixture(),token='github_pat_fixture_'+crypto.randomBytes(24).toString('hex');
 const f=await fixture({githubRequest:remote.request});let broker;
 try{
  const p=await f.project('Broker company','Connected project');const connection=await f.api('/api/projects/'+p.project.id+'/github',{method:'PUT',body:{repository:'northstar/website',branch:'main',token,allow_agent:true}});
  const thread=await f.api('/api/boards/'+p.project.id+'/chat/threads',{method:'POST',body:{}});await f.api('/api/chat/threads/'+thread.id+'/messages',{method:'POST',body:{mode:'work',content:'Inspect the connected repository and update the verified source.'}});
  const worker=await f.api('/api/connections',{method:'POST',body:{name:'Fixture worker',scope:'worker'}});
  const call=async(route,data={})=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+worker.token,'content-type':'application/json'},body:JSON.stringify(data)});const body=await r.json();if(!r.ok)throw Object.assign(Error(body.error),{status:r.status});return body;};
  const claimed=(await call('/api/worker/claim',{cloud:true})).job;assert.equal(claimed.github[0].id,connection.id);assert.ok(!JSON.stringify(claimed).includes(token));
  broker=await createGithubBroker({socketPath:path.join(f.root,'github.sock'),request:(id,action,data)=>call('/api/worker/jobs/'+claimed.id+'/github/'+id+'/'+action,data)});
  process.env.BOARDLY_GITHUB_SOCKET=broker.socketPath;const helper=require('../scripts/project-github-client.cjs');
  const status=await helper.status({connection_id:connection.id});const file=await helper.readFile({connection_id:connection.id,sha:status.sha,path:'src/app.js'});assert.equal(Buffer.from(file.content,'base64').toString(),'original source\n');
  const pushed=await helper.commitFiles({connection_id:connection.id,base_sha:status.sha,message:'Test broker push',files:[{path:'src/app.js',content:'tested broker update',encoding:'utf-8',mode:'100644'}]});assert.ok(pushed.pushed);
  assert.ok((await helper.verifyDeployment({connection_id:connection.id,sha:pushed.sha})).ready);
  const large=await helper.commitFiles({connection_id:connection.id,base_sha:pushed.sha,message:'Verify bounded larger source upload',files:[{path:'large.txt',content:'x'.repeat(1100000),encoding:'utf-8',mode:'100644'}]});assert.ok(large.pushed,'worker commits larger than the ordinary chat parser limit succeed');
  await assert.rejects(helper.verifyDeployment({connection_id:connection.id,sha:status.sha}),/Deployment paused/);
  await f.api('/api/projects/'+p.project.id+'/github',{method:'PUT',body:{allow_agent:false}});await assert.rejects(helper.status({connection_id:connection.id}),/not enabled/);
  await f.api('/api/chat/jobs/'+claimed.id+'/cancel',{method:'POST',body:{}});await assert.rejects(helper.status({connection_id:connection.id}),/Active run not found/);
  const planThread=await f.api('/api/boards/'+p.project.id+'/chat/threads',{method:'POST',body:{}});await f.api('/api/chat/threads/'+planThread.id+'/messages',{method:'POST',body:{mode:'plan',content:'Explain what is in this project without acting.'}});const plan=(await call('/api/worker/claim')).job;assert.equal(plan.github,undefined);
  console.log('PASS: real worker claim and Unix-socket GitHub helper read/push/verify, secret omission, active-job ownership, immediate revocation and no Ask/Plan broker');
 }finally{delete process.env.BOARDLY_GITHUB_SOCKET;if(broker)await broker.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
