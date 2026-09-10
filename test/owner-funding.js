const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const Database=require('better-sqlite3');
(async()=>{
 const f=await fixture();let worker;
 try{
  const p=await f.project('Company funding','Team work');
  const user=(await f.api(`/api/companies/${p.company.id}/members`,{method:'POST',body:{email:'team@example.com'}})).member.user_id;
  await f.api(`/api/boards/${p.project.id}/environment/PRIVATE_TOKEN`,{method:'PUT',body:{value:'secret-owner-environment-value'}});
  const connections=require('../server/connections').createConnections(f.root),key=connections.issue('user_owner','Cloud agent funding test','worker');connections.close();
  const w=async(route,body={})=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+key.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  assert.equal((await f.api('/api/chat/status',{user})).online,false);
  await w('/api/worker/claim',{cloud:true,subscription_bridge:true});
  assert.equal((await f.api('/api/chat/status',{user})).funding,'owner_subscription');assert.equal((await f.api('/api/chat/status',{user})).online,true);
  const thread=await f.api(`/api/boards/${p.project.id}/chat/threads`,{user,method:'POST',body:{}});
  const j=await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Add the authorized task and verify it.'}});
  const fake=path.join(f.root,'subscription-codex.cjs');
  fs.writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs'),assert=require('assert/strict');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
assert.ok(process.argv.includes('--ignore-user-config'));assert.ok(process.argv.includes('--ephemeral'));assert.ok(process.argv.includes('--output-schema'));
for(const flag of ['shell_tool','unified_exec','apps','plugins','hooks','browser_use','code_mode','multi_agent'])assert.ok(process.argv.includes('features.'+flag+'=false'));
assert.ok(process.argv.includes('mcp_servers={}'));assert.ok(!process.env.PRIVATE_TOKEN);assert.ok(!input.includes('secret-owner-environment-value'));
const payload=JSON.parse(input.slice(input.indexOf('\\n')+1));assert.ok(!payload.tools.some(t=>t.name.includes('ssh')||t.name.startsWith('github_')));
const done=payload.input.some(i=>i.type==='function_call_output');
const result=done?{text:'Created and verified the team task.',calls:[]}:{text:'Adding the requested task.',calls:[{name:'create_task',arguments:JSON.stringify({list_id:${p.list.id},title:'Owner-funded team task',description:'Verified'})}]};
fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));});`,{mode:0o700});
  const config=path.join(f.root,'worker.json');fs.writeFileSync(config,JSON.stringify({origin:f.base,token:key.token,workspaceRoot:path.join(f.root,'worker'),codexCommand:fake,cloud:true,continuous:true}));
  worker=spawn(process.execPath,[path.resolve('scripts/codex-worker.cjs'),config],{stdio:'ignore'});
  let history;for(let i=0;i<200;i++){history=await f.api(`/api/chat/threads/${thread.id}`);if(!['queued','running'].includes(history.job.status))break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(history.job.status,'completed',JSON.stringify(history));
  assert.ok((await f.api(`/api/boards/${p.project.id}`)).lists.flatMap(l=>l.cards).some(c=>c.title==='Owner-funded team task'));
  const stopped=new Promise(r=>worker.once('close',r));worker.kill('SIGTERM');await stopped;worker=null;
  const db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  const audit=db.prepare('SELECT * FROM subscription_requests').all();assert.equal(audit.length,2);assert.ok(audit.every(r=>r.payer_id==='user_owner'&&r.actor_id===user&&r.status==='completed'&&r.payload===null&&r.result===null));
  assert.equal(JSON.parse(audit[0].usage_json).input_tokens,100);
  assert.equal(db.prepare('SELECT billing_owner_id FROM chat_jobs WHERE id=?').get(j.id).billing_owner_id,'user_owner');
  assert.equal((await f.api('/api/ai/settings',{user})).has_key,false);assert.equal((await f.api('/api/ai/settings',{user})).usage.provider_cost,0);
  const pending=await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Wait while access is revoked'}});
  let claimed;for(let i=0;i<100;i++){claimed=(await w('/api/worker/claim',{cloud:true,subscription_bridge:true})).job;if(claimed)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(claimed.kind,'subscription');assert.ok(!JSON.stringify(claimed).includes('secret-owner-environment-value'));
  const grant=(await f.api(`/api/companies/${p.company.id}/members`)).members[0].grant_id;await f.api(`/api/memberships/${grant}`,{method:'DELETE'});
  assert.equal((await w(`/api/worker/subscriptions/${claimed.id}`,{status:'completed',result:{output:[]}})).status,'cancelled');
  for(let i=0;i<100;i++){history=await f.api(`/api/chat/threads/${thread.id}`);if(history.job.status==='blocked')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(history.job.id,pending.id);assert.equal(history.job.status,'blocked');db.close();
  console.log('PASS: owner subscription funding, isolated tool-free generation, permission-checked task actions, durable payer/actor/token audit, zero member charges and revocation during generation');
 }finally{if(worker)worker.kill('SIGTERM');await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
