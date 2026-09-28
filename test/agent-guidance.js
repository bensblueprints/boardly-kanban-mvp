const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {viewerFixture}=require('./computer-viewer-fixture'),{fixture}=require('./member-fixture');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await sleep(50);}throw Error('Timed out');}
async function routes(){const v=await viewerFixture(),{f}=v;try{
 const {job,thread}=await v.start(),base=`/api/chat/jobs/${job.id}/guidance`,instruction={operation_id:crypto.randomUUID(),content:'Use the next page, retaining the task.'};
 assert.equal((await f.api(v.base)).job.can_guide,true);
 await f.api(base,{method:'POST',body:instruction});await f.api(base,{method:'POST',body:instruction});
 let inbox=await f.api(base);assert.equal(inbox.instructions.length,1);assert.equal(inbox.instructions[0].received_at,null);
 assert.equal((await f.request(base,{method:'POST',body:{...instruction,content:'Changed'}})).status,409);
 assert.equal((await f.api('/api/chat/threads/'+thread.id)).messages.filter(x=>x.content===instruction.content).length,1);
 assert.equal((await v.workerApi(`/api/worker/jobs/${job.id}`,{})).guidance[0].content,instruction.content);
 await v.workerApi(`/api/worker/jobs/${job.id}/guidance`,{ids:[crypto.randomUUID()]});assert.equal((await f.api(base)).instructions[0].received_at,null);
 await v.workerApi(`/api/worker/jobs/${job.id}/guidance`,{ids:[instruction.operation_id]});assert.ok((await f.api(base)).instructions[0].received_at);
 const member=(await f.api(`/api/projects/${v.p.project.id}/members`,{method:'POST',body:{email:'guide@example.test',role:'editor'}})).member.user_id;
 assert.equal((await f.request(base,{user:member,workspace:'user_owner'})).status,404);
 assert.equal((await f.request(base,{user:member,workspace:'user_owner',method:'POST',body:{...instruction,operation_id:crypto.randomUUID()}})).status,404);
 const workerResponse=await fetch(f.base+base,{method:'POST',headers:{authorization:'Bearer '+v.worker.token,'content-type':'application/json'},body:JSON.stringify(instruction)});assert.equal(workerResponse.status,403);
 await f.api(v.base+'/takeover',{method:'POST',body:{}});
 await f.api(base,{method:'POST',body:{operation_id:crypto.randomUUID(),content:'Wait for handback'}});assert.equal(v.getMode(),'human');
 const pending=(await f.api(base)).instructions.filter(x=>!x.received_at);await v.workerApi(`/api/worker/jobs/${job.id}/guidance`,{ids:pending.map(x=>x.id)});
 await v.workerApi(`/api/worker/jobs/${job.id}`,{status:'blocked',blocker:'Need a choice',next_action:'Provide choice'});
 const resume={operation_id:crypto.randomUUID(),content:'Choose the second item',resume:true};
 assert.equal((await f.request(base,{method:'POST',body:{...resume,resume:false}})).status,409);
 await f.api(base,{method:'POST',body:resume});await f.api(base,{method:'POST',body:resume});assert.equal((await f.api(base)).job.status,'queued');assert.equal(v.getMode(),'human');
 await v.workerApi('/api/worker/claim',{cloud:true});
 // Final-result race retains the inbox and the same run, even for older workers.
 await v.workerApi(`/api/worker/jobs/${job.id}`,{status:'completed',text:'Prior turn ended'});assert.equal((await f.api(base)).job.status,'queued');
 await v.workerApi('/api/worker/claim',{cloud:true});
 await v.workerApi(`/api/worker/jobs/${job.id}`,{status:'failed',error:'AI authentication unavailable'});assert.equal((await f.api(base)).job.status,'blocked','Pending guidance must not create endless retries after a provider failure');
 await f.api(`/api/chat/jobs/${job.id}/cancel`,{method:'POST',body:{}});
 assert.equal((await f.request(base,{method:'POST',body:{operation_id:crypto.randomUUID(),content:'Do not restart cancelled work'}})).status,409);
 console.log('PASS guidance API: idempotency, persistence, scoped acknowledgements, access isolation, human control, explicit resume, final-result race and cancellation');
}finally{await f.close();}}
async function native(){const f=await fixture();let worker;try{
 const p=await f.project('Native guidance','Worker'),t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}}),j=await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'ORIGINAL_GOAL preserve this assignment'}});
 const key=await f.api('/api/connections',{method:'POST',body:{name:'Cloud agent guidance fixture',scope:'worker'}}),fake=path.join(f.root,'codex.cjs'),marker=path.join(f.root,'started');
 fs.writeFileSync(fake,`#!${process.execPath}\nconst fs=require('fs'),assert=require('assert');let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'session-guidance-fixture'}));console.log(JSON.stringify({type:'turn.started'}));if(!prompt.includes('NEW_GUIDANCE')){assert(prompt.includes('ORIGINAL_GOAL'));fs.writeFileSync(${JSON.stringify(marker)},'1');setInterval(()=>{},1000);return;}assert(process.argv.includes('session-guidance-fixture'));assert(prompt.includes('uncertain'));fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({state:'completed',summary:'Guidance followed in same session',next_step:'',blocker:'',next_action:''}));});`,{mode:0o700});
 const config=path.join(f.root,'worker.json');fs.writeFileSync(config,JSON.stringify({origin:f.base,token:key.token,workspaceRoot:path.join(f.root,'projects'),codexCommand:fake,continuous:true,cloud:true,mcpTokenFile:await f.mcpTokenFile(),once:true}));
 worker=spawn(process.execPath,[path.resolve('scripts/codex-worker.cjs'),config],{stdio:['ignore','pipe','pipe']});let log='';worker.stdout.on('data',x=>log+=x);worker.stderr.on('data',x=>log+=x);const exited=new Promise(r=>worker.once('close',r));
 await until(()=>fs.existsSync(marker));const base=`/api/chat/jobs/${j.id}/guidance`;await f.api(base,{method:'POST',body:{operation_id:crypto.randomUUID(),content:'NEW_GUIDANCE complete the saved objective'}});
 await until(async()=>{const d=await f.api(base);return d.job.status==='completed';});assert.equal(await exited,0,log);worker=null;
 assert.ok((await f.api(base)).instructions[0].received_at);assert.equal((await f.api('/api/chat/threads/'+t.id)).job.id,j.id);
 console.log('PASS native guidance: interrupts stalled turn, resumes same session/run, injects guidance and recovery caution, acknowledges delivery');
}finally{worker?.kill('SIGTERM');await f.close();}}
async function hosted(retry=false){let count=0,release,entered;const started=new Promise(r=>entered=r);const f=await fixture({providerRequest:async(url,opts)=>{
 if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});const body=JSON.parse(opts.body);count++;
 if(count===1){entered();await new Promise(r=>release=r);if(retry)return Response.json({error:{message:'Temporarily unavailable'}},{status:429});}else assert.ok(JSON.stringify(body.input).includes('NEW_HOSTED_GUIDANCE'));
 return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',usage:{input_tokens:20,output_tokens:10},output:count===1?[{type:'function_call',call_id:'obsolete',name:'save_file',arguments:JSON.stringify({name:'must-not-execute.txt',content:'old plan',folder_id:null,card_id:null})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Followed updated instructions'}]}]});}});try{
 const p=await f.project('Hosted guidance','Runner');await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
 const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}}),j=await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Original objective'}});await started;
 const base=`/api/chat/jobs/${j.id}/guidance`;await f.api(base,{method:'POST',body:{operation_id:crypto.randomUUID(),content:'NEW_HOSTED_GUIDANCE use the revised plan'}});release();
 await until(async()=>{const state=(await f.api(base)).job;if(state.status==='blocked')throw Error(JSON.stringify({retry,count,state}));return state.status==='completed';});assert.equal(count,2);assert.ok((await f.api(base)).instructions[0].received_at);
 const files=await f.api(`/api/boards/${p.project.id}/files`);assert.ok(!JSON.stringify(files).includes('must-not-execute'));
 console.log('PASS hosted guidance: in-flight provider response superseded before old tool executes, same task continues and delivery acknowledged');
}finally{release?.();await f.close();}}
(async()=>{await routes();await native();await hosted();await hosted(true);})().catch(e=>{console.error(e);process.exitCode=1;});
