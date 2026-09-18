const assert=require('node:assert/strict'),crypto=require('node:crypto'),Database=require('better-sqlite3'),path=require('node:path');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let requests=0;const f=await fixture({providerConnectorRequest:async(url,opts)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'fixture-model'}]});
  requests++;if(requests===1)return new Response('{}',{status:503});
  const body=JSON.parse(opts.body),done=body.messages.some(m=>m.role==='tool');
  return Response.json({choices:[{message:done?{content:'Recovered and verified.'}:{content:'',tool_calls:[{id:'read-once',type:'function',function:{name:'get_project',arguments:'{}'}}]}}]});
 }});
 try{
  const p=await f.project('Recovery','Transient retries');await f.api('/api/account/ai-providers/kimi',{method:'PUT',body:{token:'fixture-token-123456789'}});await f.api('/api/account/ai-providers/kimi/activate',{method:'POST'});
  const thread=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Read project state and verify recovery.'}});
  let job;for(let i=0;i<200;i++){job=(await f.api(`/api/chat/threads/${thread.id}`)).job;if(job.status==='completed')break;await delay(20);}
  assert.equal(job.status,'completed');assert.equal(requests,3,'transient provider response retried, completed tool was not repeated');
  const db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'),{readonly:true});
  const saved=JSON.parse(db.prepare('SELECT input_json FROM chat_run_checkpoints WHERE job_id=?').get(job.id).input_json);
  assert.equal(saved.filter(x=>x.type==='function_call_output'&&x.call_id==='read-once').length,1);assert.ok(!JSON.stringify(saved).includes('fixture-token'));db.close();
  console.log('PASS: transient provider recovery without user action and durable public tool-result checkpoint without credentials');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
