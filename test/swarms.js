const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {fixture}=require('./member-fixture');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const {cleanValues}=require('../server/agent-scheduling'),{safeText}=require('../server/agent-activity');
 const timestamp=1788760000009;assert.notEqual(safeText(String(timestamp)),String(timestamp));
 const scrubbed=cleanValues({updated_at:timestamp,records:[{text:'password="example value"',id:17}]},safeText);
 assert.equal(scrubbed.updated_at,timestamp);assert.equal(scrubbed.records[0].id,17);assert.equal(scrubbed.records[0].text,'password=[REDACTED]');
 const f=await fixture();let worker;
 try{
  const a=await f.project('Swarm company','Alpha'),b=await f.api('/api/projects',{method:'POST',body:{name:'Beta',parent_board_id:a.board.id}}),outside=await f.project('Other company','Private');
  const base=`/api/agents/company/${a.company.id}`;
  const store=require('../server/connections').createConnections(f.root);const key=store.issue('user_owner','Swarm test worker','worker');store.close();
  const workerApi=async(route,body={})=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+key.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const claim=()=>workerApi('/api/worker/claim');
  const body={mode:'work',request_key:crypto.randomUUID(),instruction:'Review each project',assignments:[{project_id:a.project.id,instruction:'Review Alpha'},{project_id:b.id,instruction:'Review Beta'}]};
  assert.equal((await f.request(base+'/swarms',{method:'POST',body:{...body,mode:'plan'}})).status,400);
  assert.equal((await f.request(base+'/swarms',{method:'POST',body:{...body,assignments:[{project_id:outside.project.id,instruction:''}]}})).status,400);
  const swarm=await f.api(base+'/swarms',{method:'POST',body});assert.equal(swarm.agents.length,2);
  assert.equal((await f.api(base+'/swarms',{method:'POST',body})).id,swarm.id);
  const jobs=await Promise.all([claim(),claim()]);assert.equal(new Set(jobs.map(j=>j.job.board.id)).size,2);
  const dbFile=path.join(f.root,'workspaces',crypto.createHash('sha256').update('user_owner').digest('hex'),'app.db'),db=new(require('better-sqlite3'))(dbFile);db.prepare('UPDATE chat_jobs SET updated_at=? WHERE id=?').run(Date.now()-8*3600000,jobs[0].job.id);db.close();await f.api('/api/chat/status');assert.equal((await workerApi(`/api/worker/jobs/${jobs[0].job.id}`,{progress:'Reconnected after simulated sleep'})).status,'running');
  assert.equal((await claim()).job,null);
  const t=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{}});
  const next=await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{content:'Follow-up work',mode:'work'}});
  assert.equal((await claim()).job,null,'same project writer stays queued');
  await workerApi(`/api/worker/jobs/${jobs.find(j=>j.job.board.id===a.project.id).job.id}`,{status:'completed',text:'Reviewed Alpha'});
  assert.equal((await claim()).job.id,next.id);
  await f.api(`/api/swarms/${swarm.id}/cancel`,{method:'POST',body:{}});
  await workerApi(`/api/worker/jobs/${next.id}`,{status:'completed',text:'Follow-up complete'});
  await workerApi(`/api/worker/jobs/${jobs.find(j=>j.job.board.id===b.id).job.id}`,{status:'cancelled'});
  // Default messages are Ask, and cannot obtain environment, wallet, files or session IDs.
  const ask=await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{content:'Explain without changing anything'}});
  const asked=(await claim()).job;assert.equal(asked.id,ask.id);assert.equal(asked.mode,'ask');
  for(const k of ['environment','payments','emails','files','sessionId'])assert.equal(asked[k],undefined);
  assert.equal((await fetch(f.base+`/api/worker/jobs/${ask.id}/payments`,{headers:{authorization:'Bearer '+key.token}})).status,404);
  await workerApi(`/api/worker/jobs/${ask.id}`,{status:'completed',text:'An explanation'});
  const dt=await f.api(base+'/threads',{method:'POST',body:{}});
  assert.equal((await f.request(`/api/discussions/threads/${dt.id}/messages`,{method:'POST',body:{mode:'work',content:'Change everything'}})).status,400);
  await f.api(`/api/discussions/threads/${dt.id}/messages`,{method:'POST',body:{mode:'plan',content:'Clarify a plan'}});
  const planned=(await claim()).job;assert.equal(planned.kind,'discussion');assert.equal(planned.context.projects.length,2);assert.ok(!JSON.stringify(planned.context).includes('Private'));
  await workerApi(`/api/worker/discussions/${planned.id}`,{status:'completed',text:'A plan with a question'});
  assert.equal((await f.api(`/api/discussions/threads/${dt.id}`)).runs[0].draft,'A plan with a question');
  const member=await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'swarm-viewer@example.com',role:'viewer'}});
  const memberId=member.member.user_id;
  assert.equal((await f.request(base,{user:memberId,workspace:'user_owner'})).status,403,'organization data remains owner-scoped');
  console.log('PASS: scope validation, idempotent swarms, parallel project claims, same-project ordering, read-only default, no secret brokers, saved company plans and member isolation');
  // Real scheduler with a deterministic child process: cancellation cannot kill another agent.
  const fake=path.join(f.root,'fake-codex.cjs');fs.writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('fs');let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{fs.writeFileSync('started.json',JSON.stringify({pid:process.pid,time:Date.now()}));setTimeout(()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Agent complete');fs.writeFileSync('finished.json',JSON.stringify({time:Date.now()}));},2500);});`,{mode:0o700});
  const settings=path.join(f.root,'worker.json'),workspaces=path.join(f.root,'worker-projects');fs.mkdirSync(workspaces);
  fs.writeFileSync(settings,JSON.stringify({origin:f.base,token:key.token,workspaceRoot:workspaces,codexCommand:fake,maxAgents:4}),{mode:0o600});
  const launched=await f.api(base+'/swarms',{method:'POST',body:{...body,request_key:crypto.randomUUID()}});
  worker=spawn(process.execPath,[path.resolve('scripts/codex-worker.cjs'),settings],{stdio:'ignore'});
  let state;for(let i=0;i<100;i++){state=(await f.api(base)).swarms.find(s=>s.id===launched.id);if(state.agents.every(a=>a.status==='running'))break;await delay(100);}
  assert.ok(state.agents.every(a=>a.status==='running'),'both project processes overlap');
  await f.api(`/api/chat/jobs/${state.agents[0].id}/cancel`,{method:'POST',body:{}});
  for(let i=0;i<100;i++){state=(await f.api(base)).swarms.find(s=>s.id===launched.id);if(state.agents[1].status==='completed')break;await delay(100);}
  assert.equal(state.agents[0].status,'cancelled');assert.equal(state.agents[1].status,'completed');
  console.log('PASS: worker starts concurrent processes and cancelling one leaves the other running to completion');
 }finally{if(worker){worker.kill('SIGTERM');await new Promise(r=>worker.once('close',r));}await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
