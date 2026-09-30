const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
(async()=>{
 const f=await fixture({publicAccess:true});let db;
 try{
  const a=await f.project('Monitor A','Project A'),b=await f.project('Monitor B','Project B');
  db=new(require('better-sqlite3'))(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  const card=async(p,title)=>{const full=await f.api('/api/boards/'+p.project.id),list=full.lists.find(l=>l.name==='To Do');return f.api('/api/lists/'+list.id+'/cards',{method:'POST',body:{title}});};
  const configureAPI=enabled=>f.api('/api/work-monitor',{method:'PUT',body:{enabled}});
  const enabled=await configureAPI(true);assert.equal(enabled.enabled,1);assert.equal(enabled.projects.length,2);assert.ok(enabled.projects.every(p=>p.enabled===1&&p.ordered===1));assert.ok(enabled.last_checked_at);
  await configureAPI(false);
  const employees=require('../server/project-employees').createProjectEmployees({db,ownerId:'user_owner',clean:(_id,text)=>text});
  const monitor=require('../server/work-monitor').createWorkMonitor({db,ownerId:'user_owner',employees});
  const set=enabled=>monitor.configure(enabled);
  const a1=await card(a,'First task'),a2=await card(a,'Second task'),b1=await card(b,'Independent task');
  await set(true);
  // No provider credentials are configured: jobs cannot execute external work.
  // The dispatcher still makes exactly one durable assignment.
  let jobs=db.prepare('SELECT a.*,j.status FROM employee_assignments a JOIN chat_jobs j ON j.id=a.job_id').all();assert.equal(jobs.length,1);assert.equal(jobs[0].card_id,a1.id);
  db.prepare("UPDATE chat_jobs SET status='blocked',blocker='Owner dependency' WHERE id=?").run(jobs[0].job_id);
  await set(true);
  jobs=db.prepare('SELECT a.*,j.status FROM employee_assignments a JOIN chat_jobs j ON j.id=a.job_id ORDER BY a.rowid').all();assert.equal(jobs.length,2);assert.equal(jobs[1].card_id,b1.id,'a blocked project must not starve another company');
  db.prepare("UPDATE chat_jobs SET status='cancelled' WHERE id=?").run(jobs[1].job_id);
  await set(true);
  jobs=db.prepare('SELECT a.*,j.status FROM employee_assignments a JOIN chat_jobs j ON j.id=a.job_id ORDER BY a.rowid').all();assert.equal(jobs.length,3);assert.equal(jobs[2].card_id,a2.id);
  db.prepare("UPDATE chat_jobs SET status='completed' WHERE id=?").run(jobs[2].job_id);await set(true);assert.equal(db.prepare('SELECT count(*) n FROM employee_assignments').get().n,3,'completed, blocked and cancelled assignments must not loop');
  const c=await f.project('New company','New project');
  monitor.tick();assert.equal(monitor.status().projects.find(p=>p.id===c.project.id).enabled,1,'new projects become monitored');
  employees.configure(c.project.id,false,'');monitor.tick();assert.equal(monitor.status().projects.find(p=>p.id===c.project.id).enabled,0,'respect explicit per-project pause');
  await set(false);assert.ok(monitor.status().projects.every(p=>p.enabled===0));
  const other=await f.api('/api/work-monitor',{user:'user_unrelated'});assert.equal(other.enabled,0);assert.equal(other.projects.length,0);
  const member=await f.api('/api/projects/'+a.project.id+'/members',{method:'POST',body:{email:'monitor-viewer@example.com',role:'viewer'}});
  assert.equal((await f.request('/api/work-monitor',{user:member.member.user_id,workspace:'user_owner',method:'PUT',body:{enabled:true}})).status,403);
  console.log('PASS: continuous monitoring, new companies, fair serialized dispatch, blocked/cancelled work, explicit pauses and owner isolation');
 }finally{if(db)db.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
