const assert=require('node:assert/strict'),crypto=require('node:crypto'),net=require('node:net'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Server,utils}=require('ssh2'),{fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud'),{loadKey}=require('../server/project-environment');
const {createSshConnections}=require('../server/ssh-connections'),{createComputerUseVision}=require('../server/computeruse-vision'),{createComputerUseConnections}=require('../server/computeruse-connections');
const MODEL='Qwen3-VL-8B-Instruct-Q4_K_M',frame='data:image/jpeg;base64,/9j/2Q==',desktop_id=crypto.randomUUID(),token='cu_fixture_private_vision_12345';
(async()=>{
 let sshServer,gpu,db,broker,step=0,offline=false,onInspect=()=>{},sawLocal=false,human=false;const sockets=new Set(),seen=[];
 const inventory={id:'account-one',rentals:[],desktops:[{id:desktop_id,kind:'pilot',state:'active',available:true,memory_mib:8192,label:'Test desktop'}]};
 const desktopRequest=async(o,k,c,d)=>{assert.equal(k,token);seen.push(c);if(human&&c==='lease')throw Object.assign(Error('Human takeover'),{status:409});if(c==='lease')return{lease:'private-lease',expires:Math.floor(Date.now()/1000)+60};if(c==='screenshot')return{image_url:frame};return{mode:'agent',state:'completed'};};
 const f=await fixture({publicAccess:true,computeruseOrigin:'https://computer.example',computeruseRequest:async()=>inventory,computeruseDesktopRequest:desktopRequest,providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const b=JSON.parse(opts.body);assert.ok(!opts.body.includes(frame));assert.ok(!opts.body.includes('input_image'));assert.ok(!opts.body.includes(token));
  if(step===2){assert.ok(opts.body.includes('Local fixture observation'));sawLocal=true;}
  const names=['inspect_project_computer','computer_inspect','computer_action','computer_release'],name=names[step++];
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',usage:{input_tokens:100,output_tokens:20},output:[name?{type:'function_call',call_id:crypto.randomUUID(),name,arguments:JSON.stringify(name==='inspect_project_computer'?{}:{desktop_id,question:'Locate Start',action_json:'{"type":"key","key":"Escape"}'})}:{type:'message',role:'assistant',content:[{type:'output_text',text:'Local desktop verified.'}]}]});
 }});
 try{
  gpu=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);assert.equal(req.url,'/inspect');assert.ok(body.image_url.startsWith('data:image/'));await onInspect(body);if(offline){res.writeHead(503);return res.end('{}');}res.setHeader('content-type','application/json');res.end(JSON.stringify({protocol:1,mode:'local',model:MODEL,observation:body.question.includes('large heading')?'BOARDLY 42':'Local fixture observation: Start at (780,730).',image_url:frame,unexpected:'must be dropped',elapsed_ms:25}));});
  await new Promise((resolve,reject)=>{gpu.once('error',reject);gpu.listen(18765,'127.0.0.1',resolve);});
  const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}),password='fixture-'+crypto.randomUUID(),fingerprint='SHA256:'+crypto.createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/,'');
  sshServer=new Server({hostKeys:[key]},client=>{sockets.add(client);client.on('close',()=>sockets.delete(client));client.on('error',()=>{});client.on('authentication',c=>c.method==='password'&&c.password===password?c.accept():c.reject());client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{assert.equal(info.destIP,'127.0.0.1');assert.ok([18765,sshServer.address().port].includes(info.destPort));const remote=net.connect(info.destPort,info.destIP,()=>{const stream=accept();stream.on('error',()=>remote.destroy());remote.on('error',()=>stream.destroy());remote.pipe(stream).pipe(remote);});remote.on('error',()=>reject());}));});
  await new Promise(r=>sshServer.listen(0,'127.0.0.1',r));
  const p=await f.project('GPU account','Computer'),base='/api/account/computeruse/vision';
  const config={host:'127.0.0.1',port:sshServer.address().port,username:'qa',auth_type:'password',password,fingerprint,allow_agent:true};
  const jump=await f.api('/api/account/ssh',{method:'POST',body:{...config,label:'Jump'}}),connection=await f.api('/api/account/ssh',{method:'POST',body:{...config,label:'Private GPU',jump_id:jump.id}}),cid=connection.id;
  assert.equal((await f.api(base)).mode,'gpt');
  assert.equal((await f.request(base,{method:'PUT',body:{mode:'local',connection_id:cid}})).status,409,'local mode requires successful inference test');
  assert.equal((await f.api(base+'/test',{method:'POST',body:{connection_id:cid}})).ready,true,'actual HTTP over two SSH hops');
  await f.api(base,{method:'PUT',body:{mode:'local',connection_id:cid}});
  await f.api('/api/account/computeruse',{method:'PUT',body:{token}});
  await f.api(`/api/projects/${p.project.id}/computeruse`,{method:'PUT',body:{rental_ids:['desktop:'+desktop_id],allow_agent:true,allow_control:true}});
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  const thread=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Read the screen with my GPU.'}});
  let h;for(let i=0;i<400;i++){h=await f.api(`/api/chat/threads/${thread.id}`);if(h.job.status==='completed')break;await new Promise(r=>setTimeout(r,20));}assert.equal(h.job.status,'completed',JSON.stringify(h.job));assert.ok(sawLocal);assert.ok(seen.includes('action'));
  db=new(require('better-sqlite3'))(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  const ssh=createSshConnections({db,key:loadKey(f.root),namespace:'user_owner'}),vision=createComputerUseVision({db,ssh,namespace:'user_owner'});
  const cu=createComputerUseConnections({db,key:loadKey(f.root),namespace:'user_owner',origin:'https://computer.example',request:async()=>inventory,desktopRequest,vision});
  const run=(command,actor='user_owner',valid=()=>{})=>cu.controlForAgent(p.project.id,actor,'fixture-run',command,{desktop_id,question:'Locate Start'},valid);
  const local=await run('screenshot');assert.equal(local.mode,'local');assert.ok(!JSON.stringify(local).includes(frame));assert.ok(!('unexpected' in local));
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'local-frames-'));process.env.BOARDLY_COMPUTER_SOCKET=path.join(temp,'computer.sock');process.env.BOARDLY_COMPUTER_FRAMES=temp;
  broker=await require('../scripts/computeruse-broker.cjs').createComputerUseBroker({socketPath:process.env.BOARDLY_COMPUTER_SOCKET,request:(command)=>command==='release-all'?cu.releaseRun('fixture-run'):run(command)});
  const helper=require('../scripts/project-computeruse-client.cjs');assert.equal((await helper.screenshot({desktop_id})).mode,'local');assert.equal((await helper.inspect({desktop_id,question:'Locate Start'})).mode,'local');assert.deepEqual(fs.readdirSync(temp),['computer.sock'],'Codex receives no image file in local mode');
  await broker.close();broker=null;fs.rmSync(temp,{recursive:true,force:true});delete process.env.BOARDLY_COMPUTER_SOCKET;delete process.env.BOARDLY_COMPUTER_FRAMES;
  onInspect=()=>{human=true;};await assert.rejects(()=>run('screenshot'),/Human takeover/);human=false;onInspect=()=>{};
  offline=true;await assert.rejects(()=>run('screenshot'),/busy or unavailable/);assert.equal(vision.context().mode,'local','offline never switches to GPT');offline=false;
  onInspect=()=>vision.save({mode:'gpt',connection_id:cid});await assert.rejects(()=>run('screenshot'),/changed/);onInspect=()=>{};
  assert.equal((await run('screenshot')).image_url,frame,'switching back restores GPT images');await cu.releaseRun('fixture-run');vision.save({mode:'local',connection_id:cid});
  let valid=true;onInspect=()=>{valid=false;};await assert.rejects(()=>run('inspect','user_owner',()=>{if(!valid)throw Error('revoked');}),/permission changed|revoked/);onInspect=()=>{};await cu.releaseRun('fixture-run');
  await f.api(`/api/account/ssh/${cid}`,{method:'PATCH',body:{access:{mode:'owner',member_ids:[]}}});
  const member=(await f.api(`/api/companies/${p.company.id}/members`,{method:'POST',body:{email:'gpu-member@example.com',role:'editor'}})).member.user_id;
  assert.equal((await f.request(base,{user:member,workspace:'user_owner'})).status,403);
  await assert.rejects(()=>run('inspect',member),/not assigned/);await cu.releaseRun('fixture-run');
  f.users.push({id:'user_second',emailAddresses:[{emailAddress:'second@example.com',verification:{status:'verified'}}]});await f.project('Other account','Other project','user_second');
  assert.equal((await f.request(base,{user:'user_second',method:'PUT',body:{mode:'local',connection_id:cid}})).status,400,'cross-account GPU IDs rejected');
  await f.api(`/api/account/ssh/${cid}`,{method:'PATCH',body:{allow_agent:false}});await assert.rejects(()=>run('screenshot'),/Enable agent access/);assert.equal(vision.context().mode,'local');
  console.log('PASS: private Qwen through pinned SSH and jump host; setup test; hosted GPT text-only cycle; native helper no images; reversible modes; offline no fallback; mode/member/connection revocation; cross-account isolation');
 }finally{await broker?.close();for(const s of sockets)s.end();await new Promise(r=>sshServer?sshServer.close(r):r());await new Promise(r=>gpu?gpu.close(r):r());db?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
