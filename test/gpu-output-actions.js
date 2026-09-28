const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),net=require('node:net'),fs=require('node:fs'),path=require('node:path'),{Duplex}=require('node:stream');
const Database=require('better-sqlite3'),{fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud'),{createGpuOutputActions}=require('../server/gpu-output-actions');
(async()=>{
 const f=await fixture();let db,server;
 try{
  const p=await f.project(),dir=workspacePath(f.root,'user_owner');db=new Database(path.join(dir,'app.db'));const uploadsDir=path.join(dir,'uploads');fs.mkdirSync(uploadsDir,{recursive:true});
  const bytes=crypto.randomBytes(5*1024*1024+211);let downloads=0,enabled=true,limit=20*1024*1024,enqueue=0;
  server=http.createServer((req,res)=>{downloads++;res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);});server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const ssh={forService(){if(!enabled)throw Object.assign(Error('Revoked'),{status:403});return{updated_at:1};},async execute(c,o){const socket=net.connect(server.address().port,'127.0.0.1');const stream=Duplex.from({readable:socket,writable:socket});assert.equal(stream.setTimeout,undefined,'Same stream API as ssh2 channels');try{return await o.consumeForward(stream,()=>enabled);}finally{stream.destroy();socket.destroy();}}};
  const actions=createGpuOutputActions({db,uploadsDir,ssh,ownerId:'user_owner',storageLimit:()=>limit,chat:{hosted:{enqueue(){enqueue++;}}}}),worker={config:{ports:[8188]},ssh_id:'test'},file={filename:'generated.mp4',subfolder:'run',type:'output'},args={worker,port:8188,file,project_id:p.project.id,step_id:crypto.randomUUID(),index:0};
  const saved=await actions.saveOutput(args);assert.equal(saved.size,bytes.length);assert.deepEqual(fs.readFileSync(path.join(uploadsDir,saved.filename)),bytes);assert.equal((await actions.saveOutput(args)).id,saved.id);assert.equal(downloads,1,'A repeated handoff reuses the project file');
  const id=crypto.randomUUID(),jobArgs={id,project_id:p.project.id,instruction:'Email the finished video to client@example.test',context:{files:[{id:saved.id,name:saved.name}]},runtime:'codex'};
  const job=actions.start(jobArgs);assert.equal(job.status,'queued');assert.equal(actions.start(jobArgs).thread_id,job.thread_id);assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_jobs WHERE id=?').get(id).n,1);
  assert.match(db.prepare('SELECT content FROM chat_messages WHERE thread_id=?').get(job.thread_id).content,/generated.mp4/);assert.equal(enqueue,0);
  const p2=await f.project('Second','Second');assert.throws(()=>actions.start({...jobArgs,project_id:p2.project.id}),/another project/);actions.cancel(id);assert.equal(actions.status(id).status,'cancelled');
  limit=bytes.length;await assert.rejects(()=>actions.saveOutput({...args,step_id:crypto.randomUUID()}),/storage allowance/);
  enabled=false;await assert.rejects(()=>actions.saveOutput({...args,step_id:crypto.randomUUID()}),/Revoked/);
  await assert.rejects(()=>actions.saveOutput({...args,port:22}),/Invalid GPU output/);
  console.log('PASS: real HTTP over an SSH-compatible stream, 5 MB binary integrity, quota enforcement, idempotent project upload and scoped action dispatch/cancel');
 }finally{if(server)await new Promise(r=>server.close(r));if(db)db.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
