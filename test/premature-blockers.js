const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {fixture}=require('./member-fixture');
(async()=>{
 let calls=0;
 const f=await fixture({providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const body=JSON.parse(opts.body);calls++;
  if(calls===2)assert.ok(body.input.some(x=>x.type==='function_call_output'&&String(x.output).includes('Before stopping')));
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',usage:{input_tokens:10,output_tokens:10},output:calls===1?[{type:'function_call',id:'fc_review',call_id:'review',name:'report_blocker',arguments:JSON.stringify({summary:'Connection appeared stale.',blocker:'A tool failed once.',next_action:'Click Start work to retry.'})},{type:'function_call',id:'fc_duplicate',call_id:'duplicate',name:'report_blocker',arguments:JSON.stringify({summary:'Still stopped.',blocker:'A tool failed once.',next_action:'Retry.'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Rechecked the saved state; verified the requested work is complete.'}]}]});
 }});
 try{
  const p=await f.project('Premature blockers','Recovery');
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});
  await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Complete and verify this task.'}});
  let h;for(let i=0;i<100;i++){h=await f.api(`/api/chat/threads/${t.id}`);if(h.job.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(h.job.status,'completed');assert.equal(calls,2);assert.equal(h.job.blocker_card_id,null);
 }finally{await f.close();}
 const n=await fixture();try{
  const p=await n.project('Native checkpoint repair','Recovery');
  const store=require('../server/connections').createConnections(n.root),key=store.issue('user_owner','Recovery test','worker');store.close();
  const fake=path.join(n.root,'repair.cjs');fs.writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{const n=fs.existsSync('turn')?Number(fs.readFileSync('turn'))+1:1;fs.writeFileSync('turn',String(n));console.log(JSON.stringify({type:'thread.started',thread_id:'repair-session'}));const out=process.argv[process.argv.indexOf('-o')+1];if(n===1)return fs.writeFileSync(out,'invalid JSON');if(n===2&&!prompt.includes('last checkpoint was invalid'))process.exit(3);if(n===3&&!prompt.includes('Before stopping'))process.exit(4);fs.writeFileSync(out,JSON.stringify({state:n===2?'blocked':'completed',summary:'Verified saved work',next_step:'',blocker:n===2?'A tool failed once':'',next_action:n===2?'Click Start work':''}));});`,{mode:0o700});
  const config=path.join(n.root,'worker.json');fs.writeFileSync(config,JSON.stringify({origin:n.base,token:key.token,workspaceRoot:path.join(n.root,'projects'),codexCommand:fake,continuous:true,cloud:true,mcpTokenFile:await n.mcpTokenFile(),once:true}));
  const t=await n.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});
  await n.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Complete the saved work.'}});
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve('scripts/codex-worker.cjs'),config],{stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Worker exit '+code)));});
  const h=await n.api(`/api/chat/threads/${t.id}`);assert.equal(h.job.status,'completed');assert.equal(h.job.continuation_count,3);assert.equal(h.job.blocker_card_id,null);
 }finally{await n.close();}
 console.log('PASS: hosted and native premature blockers recover without user resume; native invalid checkpoint repairs automatically');
})().catch(e=>{console.error(e);process.exitCode=1;});
