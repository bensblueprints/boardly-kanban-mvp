const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const Database=require('better-sqlite3'),{createGpuWorkflows,interpolate}=require('../server/gpu-workflows');
const {fixture}=require('./member-fixture');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gpu-workflows-')),db=new Database(path.join(root,'gpu.db'));db.pragma('foreign_keys=ON');
 let online=true,enabled=true,submitted=new Map(),pendingText=null,releaseText;
 const ssh={forService(id){if(!enabled)throw Object.assign(Error('Access disabled'),{status:403});return{id};},list:()=>[{id:'ssh-a',label:'Test GPU',allow_agent:enabled}]};
 const remote=async(w,p)=>{if(!online)throw Object.assign(Error('Offline'),{status:502});if(p.action==='snapshot')return{gpus:[{uuid:'GPU-'+w.ssh_id,name:'RTX fixture',memory_total:24000,memory_used:1000,utilization:3}],engines:[{port:8188,online:true}],jobs:[],observed_at:Date.now()};if(submitted.has(p.id))return{status:'completed',outputs:[{filename:'result.png',subfolder:'test',type:'output'}]};assert.ok(p.workflow['1'].inputs.text.includes('scene'));submitted.set(p.id,p.workflow);return{status:'submitted'};};
 const generate=async()=>pendingText?pendingText:{output_text:'A cinematic scene with a red balloon.'};
 const make=()=>createGpuWorkflows({db,ssh,ownerId:'owner',generate,remote,interval:3600000});let gpu=make();
 const app=express();app.use((req,res,next)=>{req.workspaceIsOwner=req.headers['x-owner']==='yes';next();});app.use((req,res,next)=>gpu.router(req,res,next));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const request=async(route,body,method='POST',owner=true)=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json','x-owner':owner?'yes':'no'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
 try {
  assert.equal((await request('/api/gpu/dashboard',undefined,'GET')).status,409);
  assert.equal((await request('/api/gpu/workers',undefined,'GET',false)).status,403);
  const w=await gpu.addWorker({name:'RTX test',ssh_id:'ssh-a',ports:[8188]});
  await assert.rejects(()=>gpu.addWorker({name:'Duplicate',ssh_id:'ssh-a',ports:[8188]}),/already registered/);
  await assert.rejects(()=>gpu.addWorker({name:'Invalid',ssh_id:'ssh-b',ports:[0]}),/valid ComfyUI/);
  const template=gpu.addTemplate({name:'Image template',worker_id:w.id,kind:'image',port:8188,graph:{'1':{class_type:'CLIPTextEncode',inputs:{text:'{{prompt}}',seed:'{{seed}}'}}}});
  assert.throws(()=>gpu.addTemplate({...template,graph:{'1':{class_type:'CLIPTextEncode',inputs:{text:'fixed'}}}}),/Add \{\{prompt/);
  const wf=gpu.saveWorkflow({name:'Prompt to image to caption',steps:[{kind:'prompt',prompt:'Describe {{prompt}}'},{kind:'image',template_id:template.id,prompt:'{{previous_text}}'},{kind:'prompt',prompt:'Caption {{previous_text}}'}]});
  const id=crypto.randomUUID();gpu.start(wf.id,{request_id:id,prompt:'scene'});
  await wait(20);await gpu.tick();await gpu.tick();await gpu.tick();
  assert.equal(gpu.run(id).status,'completed');assert.equal(submitted.size,1);assert.equal(gpu.run(id).steps[2].text,'A cinematic scene with a red balloon.');
  assert.equal(gpu.start(wf.id,{request_id:id,prompt:'scene'}).id,id);assert.equal(submitted.size,1,'Idempotent start does not rerender');
  assert.throws(()=>gpu.start(wf.id,{request_id:id,prompt:'different'}),/another run/);
  const imageOnly=gpu.saveWorkflow({name:'Image only',steps:[{kind:'image',template_id:template.id,prompt:'scene {{prompt}}'}]});
  const restart=crypto.randomUUID();gpu.start(imageOnly.id,{request_id:restart,prompt:'sunset'});await wait(20);assert.equal(gpu.run(restart).steps[0].status,'submitted');
  gpu.close();gpu=make();await wait(20);assert.equal(gpu.run(restart).status,'completed');assert.equal(submitted.size,2,'Restart reconciles stable render UUID');
  online=false;await gpu.scan(w);assert.match(gpu.workers()[0].error,/Offline/);assert.ok(gpu.workers()[0].snapshot,'Last snapshot is retained and marked stale');online=true;
  pendingText=new Promise(r=>releaseText=r);const cancelId=crypto.randomUUID();gpu.start(wf.id,{request_id:cancelId,prompt:'scene'});await wait(20);
  await request('/api/gpu/runs/'+cancelId+'/cancel',{});releaseText({output_text:'Late text'});await wait(20);assert.equal(gpu.run(cancelId).status,'cancelled','Late response cannot undo cancellation');pendingText=null;
  assert.equal((await request('/api/gpu/workers/'+w.id+'/output?port=22&filename=key.png',undefined,'GET')).status,400);
  const before=submitted.size;enabled=false;await assert.rejects(()=>gpu.addWorker({name:'Disabled',ssh_id:'ssh-b'}),/disabled/);assert.equal(submitted.size,before);
  const quote='scene " \\ \n $(touch /tmp/should-not-exist)';assert.equal(interpolate({text:'{{prompt}}'},{prompt:quote}).text,quote);
  assert.ok(!fs.existsSync('/tmp/should-not-exist'));
  console.log('PASS: worker gate, owner permissions, detection, duplicate registration, templates, prompt→image→prompt, idempotent start, restart reconciliation, stale telemetry, cancellation race, port validation and interpolation');
 } finally {gpu.close();await new Promise(r=>server.close(r));db.close();fs.rmSync(root,{recursive:true,force:true});}
 const f=await fixture();try{
  const p=await f.project();const member=(await f.api('/api/projects/'+p.project.id+'/members',{method:'POST',body:{email:'gpu-viewer@example.com',role:'editor'}})).member.user_id;
  assert.equal((await f.request('/api/gpu/status',{user:member,workspace:'user_owner'})).status,403);
  assert.equal((await f.request('/api/gpu/workers',{user:member,workspace:'user_owner'})).status,403);
  assert.equal((await f.api('/api/gpu/status')).enabled,false);assert.equal((await f.request('/api/gpu/dashboard')).status,409);
  assert.equal((await fetch(f.base+'/api/gpu/workers')).status,401);
  console.log('PASS: real cloud middleware rejects anonymous/shared-member GPU access and gates accounts without a worker');
 } finally {await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
