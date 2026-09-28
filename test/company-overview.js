const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
(async()=>{
 const {workStatus,agentState}=await import('../client/src/company-status.mjs');
 const now=Date.now(),empty={total_tasks:0,done_tasks:0,blocked_tasks:0},done={total_tasks:2,done_tasks:2,blocked_tasks:0},todo={total_tasks:2,done_tasks:0,blocked_tasks:0},blocked={...todo,blocked_tasks:1};
 const active={status:'running',updated_at:now},stale={status:'running',updated_at:now-20000};
 assert.equal(workStatus([empty],[],now).state,'idle');assert.equal(workStatus([done],[],now).state,'done');assert.equal(workStatus([todo],[],now).state,'idle');assert.equal(workStatus([todo],[active],now).state,'working');assert.equal(workStatus([blocked],[active],now).state,'blocked');assert.equal(workStatus([done],[stale],now).state,'idle');assert.equal(workStatus([done],[{status:'queued'}],now).state,'idle');assert.equal(agentState(stale,now).label,'Waiting for worker');assert.equal(agentState(active,now+16000).state,'idle');
 const f=await fixture({publicAccess:true});let db;
 try{
  const a=await f.project('Active company','Working project'),b=await f.project('Completed company','Finished project'),c=await f.project('Blocked company','Waiting project');await f.api('/api/companies',{method:'POST',body:{name:'Empty company'}});
  for(const [project,state]of[[a,'To Do'],[b,'Done Awaiting Revisions'],[c,'Blocked']]){const full=await f.api('/api/boards/'+project.project.id);let list=full.lists.find(l=>l.name===state);if(!list)list=await f.api('/api/boards/'+project.project.id+'/lists',{method:'POST',body:{name:state}});await f.api('/api/lists/'+list.id+'/cards',{method:'POST',body:{title:state+' fixture'}});}
  db=new(require('better-sqlite3'))(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  for(let i=0;i<106;i++){const tid=crypto.randomUUID(),mid=crypto.randomUUID(),jid=crypto.randomUUID();db.prepare('INSERT INTO chat_threads(id,board_id,title,created_at) VALUES(?,?,?,?)').run(tid,a.project.id,'Agent '+i,now);db.prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?)').run(mid,tid,'user','Fixture assignment',now);db.prepare('INSERT INTO chat_jobs(id,thread_id,message_id,status,created_at,updated_at,mode,runtime,requested_by) VALUES(?,?,?,?,?,?,?,?,?)').run(jid,tid,mid,i===0?'running':'queued',now,now,'work','codex','user_owner');}
  const dt=crypto.randomUUID();db.prepare('INSERT INTO discussion_threads VALUES(?,?,?,?,?)').run(dt,'company',a.company.id,'Company planning',now);db.prepare('INSERT INTO discussion_jobs(id,thread_id,mode,prompt,status,runtime,requested_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),dt,'plan','Plan the next launch','running','codex','user_owner',now,now);
  const overview=await f.api('/api/agents/companies/dashboard');assert.equal(overview.companies.length,4);assert.equal(overview.agents.length,107,'include every project and discussion agent without a 100-row truncation');assert.equal(overview.agents.filter(x=>x.kind==='company').length,1);
  const status=company=>workStatus(overview.projects.filter(p=>p.company_id===company.id),overview.agents.filter(a=>a.company_id===company.id),now);
  assert.equal(status(a.company).state,'working');assert.equal(status(b.company).state,'done');assert.equal(status(c.company).state,'blocked');assert.equal(status(overview.companies.find(c=>c.name==='Empty company')).state,'idle');
  const other=await f.api('/api/agents/companies/dashboard',{user:'user_unrelated'});assert.equal(other.companies.length,0);assert.equal(other.agents.length,0);
  const member=await f.api('/api/projects/'+a.project.id+'/members',{method:'POST',body:{email:'graph-viewer@example.com',role:'viewer'}});const forbidden=await f.request('/api/agents/companies/dashboard',{user:member.member.user_id,workspace:'user_owner'});assert.equal(forbidden.status,403);
  console.log('PASS: company overview includes all agents and company discussions, correct four-color precedence, empty/queued/stale handling, completed tasks and account/member isolation');
 }finally{if(db)db.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
