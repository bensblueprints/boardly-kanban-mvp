const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),{spawn}=require('node:child_process');
const Database=require('better-sqlite3'),{fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
(async()=>{
 const secrets={fal:'fixture-fal-key-secret',higgsfield:'fixture-higgsfield-id:fixture-higgsfield-secret'},jobs=new Map(),calls=[];let failed=false,redirect=false,network=false;
 const fake=async(url,opt)=>{
  const p=url.startsWith('https://queue.fal.run/')?'fal':'higgsfield';assert.ok(url.startsWith(p==='fal'?'https://queue.fal.run/':'https://api.higgsfield.ai/'));assert.equal(opt.headers.Authorization,'Key '+secrets[p]);assert.equal(opt.redirect,'error');calls.push({url,method:opt.method});
  if(network)throw Error('Private provider error '+secrets[p]);
  if(!url.includes('/requests/')){const id=crypto.randomUUID(),base=p==='fal'?'https://queue.fal.run/fal-ai/flux/requests/':'https://api.higgsfield.ai/requests/',r={request_id:id,status_url:base+id+'/status',cancel_url:base+id+'/cancel',response_url:base+id};jobs.set(id,{p});if(redirect)r.status_url='https://evil.example/'+id;return Response.json(r);}
  if(url.endsWith('/cancel'))return p==='fal'?Response.json({status:'CANCELLATION_REQUESTED'},{status:202}):new Response(null,{status:202});
  if(url.endsWith('/status'))return Response.json({status:failed?'failed':p==='fal'?'COMPLETED':'completed',images:[{url:'https://media.example/output.png'}],error:failed?'fixture-error':null});
  return Response.json({images:[{url:'https://media.example/output.png'},{url:'javascript:alert(1)'}]});
 };
 const f=await fixture({publicAccess:true,mediaRequest:fake});try{
  const a=await f.project('Media company','Media project'),other=await f.project('Private','Other');
  for(const provider of ['fal','higgsfield']){
   const account='/api/account/media/'+provider;
   await f.api(account,{method:'PUT',body:{token:secrets[provider],model:provider==='fal'?'fal-ai/flux/schnell':'higgsfield-ai/soul/v2/standard',defaults:{},daily_limit:3}});
   assert.equal(calls.length,provider==='fal'?0:calls.length,'Saving keys must not generate media');
   assert.equal((await f.api(account)).verified,false);assert.equal((await f.api(account,{user:'user_other'})).saved,false);
   const project='/api/projects/'+a.project.id+'/media/'+provider,generate=body=>f.request(project+'/generate',{method:'POST',body});
   assert.equal((await generate({prompt:'Unauthorized',request_key:crypto.randomUUID()})).status,403);
   await f.api('/api/companies/'+a.company.id+'/media/'+provider,{method:'PUT',body:{enabled:true}});
   assert.equal((await f.api(project)).inherited,true);
   const key=crypto.randomUUID(),body={prompt:'An authorized landscape',request_key:key};
   const r=await f.api(project+'/generate',{method:'POST',body});assert.equal(r.status,'queued');const n=calls.length;
   assert.equal((await f.api(project+'/generate',{method:'POST',body})).id,r.id);assert.equal(calls.length,n,'Duplicate submit cannot charge twice');
   assert.equal((await generate({...body,prompt:'Changed input'})).status,409);
   assert.equal((await f.request('/api/projects/'+other.project.id+'/media-jobs/'+r.id+'/refresh',{method:'POST'})).status,404);
   const done=await f.api('/api/projects/'+a.project.id+'/media-jobs/'+r.id+'/refresh',{method:'POST'});assert.equal(done.status,'completed');assert.deepEqual(done.outputs,['https://media.example/output.png']);
   assert.equal((await f.api(account)).verified,true);
   const cancel=await f.api(project+'/generate',{method:'POST',body:{prompt:'Cancel this one',request_key:crypto.randomUUID()}});
   const cancelled=await f.api('/api/projects/'+a.project.id+'/media-jobs/'+cancel.id+'/cancel',{method:'POST'});assert.equal(cancelled.status,provider==='fal'?'cancellation_requested':'canceled');
   assert.equal(calls.at(-1).method,provider==='fal'?'PUT':'POST');
   network=true;const uncertainBody={prompt:'Uncertain generation',request_key:crypto.randomUUID()};assert.equal((await generate(uncertainBody)).status,502);network=false;
   const before=calls.length,uncertain=await f.api(project+'/generate',{method:'POST',body:uncertainBody});assert.equal(uncertain.status,'uncertain');assert.equal(calls.length,before);
   assert.equal((await generate({prompt:'Over limit',request_key:crypto.randomUUID()})).status,429);
   const records=await f.api(project);assert.ok(!JSON.stringify(records).includes(secrets[provider]));
   await f.api('/api/companies/'+a.company.id+'/media/'+provider,{method:'PUT',body:{enabled:false}});assert.equal((await generate({prompt:'Revoked',request_key:crypto.randomUUID()})).status,403);
  }
  const member=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'viewer@example.com'}})).member.user_id;
  assert.equal((await f.request('/api/account/media/fal',{user:member,workspace:'user_owner'})).status,403);
  const db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM media_connections').all()).includes(secrets.fal));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM media_jobs').all()).includes(secrets.fal));db.close();
  // Native Codex workers get an account-bound broker, never the provider key.
  await f.api('/api/account/media/fal',{method:'PUT',body:{model:'fal-ai/flux/schnell',defaults:{},daily_limit:10}});
  await f.api('/api/projects/'+a.project.id+'/media/fal',{method:'PUT',body:{enabled:true}});
  const connections=require('../server/connections').createConnections(f.root),w=connections.issue('user_owner','Media worker fixture','worker');connections.close();
  const worker=async(route,body)=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+w.token,'content-type':'application/json'},body:JSON.stringify(body||{})});assert.ok(r.ok,await r.clone().text());return r.json();};
  await worker('/api/worker/claim',{cloud:true});const thread=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{}});
  await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Generate the authorized art'}});const claimed=(await worker('/api/worker/claim',{cloud:true})).job;assert.equal(claimed.media,true);assert.ok(!JSON.stringify(claimed).includes(secrets.fal));
  const base=`/api/worker/jobs/${claimed.id}/media/`;assert.equal((await worker(base+'list')).length,1);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'media-broker-'));
  const broker=await require('../scripts/media-broker.cjs').createMediaBroker({socketPath:path.join(temp,'media.sock'),request:(action,data)=>worker(base+action,data)});
  try{
   const code=`const c=require(${JSON.stringify(path.resolve('scripts/project-media-client.cjs'))});(async()=>{const r=await c.generate({provider:'fal',prompt:'Native worker art',request_key:${JSON.stringify(crypto.randomUUID())}});const s=await c.status({job_id:r.id});if(s.status!=='completed')process.exitCode=1;})().catch(()=>process.exitCode=1);`;
   const child=spawn(process.execPath,['-e',code],{env:{PATH:process.env.PATH,BOARDLY_MEDIA_SOCKET:broker.socketPath},stdio:'pipe'});assert.equal(await new Promise(r=>child.once('close',r)),0);
  }finally{await broker.close();fs.rmSync(temp,{recursive:true,force:true});}
  const disk=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));disk.prepare("UPDATE chat_jobs SET status='cancelled' WHERE id=?").run(claimed.id);disk.close();
  // Provider-controlled job URLs cannot redirect the credential to another host.
  redirect=true;const bad=await f.request('/api/projects/'+a.project.id+'/media/fal/generate',{method:'POST',body:{prompt:'Unsafe URL fixture',request_key:crypto.randomUUID()}});assert.equal(bad.status,502);assert.ok(calls.every(c=>!c.url.includes('evil.example')));
 }finally{await f.close();}
 console.log('PASS: customer-owned encrypted media keys; scoped opt-in; durable async jobs; duplicate/uncertain no-resubmit; daily caps; result sanitization; cancel methods; member isolation; native worker broker; fixed provider hosts');
})().catch(e=>{console.error(e);process.exitCode=1;});
