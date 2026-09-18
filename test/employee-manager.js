process.env.BOARDLY_MAX_AGENTS='1';
const assert=require('node:assert/strict'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){const result=await fn();if(result)return result;await pause(20);}throw Error('Timed out');}
(async()=>{
 let roster,managerCalls=0,completedChildren=0,blockChild=false,holdChild=false,releaseChild,childEntered;
 const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const f=await fixture({providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'manager-fixture'}]});
  const body=JSON.parse(options.body),user=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  let response;
  if(/You are (Alex|Sam)/.test(user)){
   assert.ok(!body.tools.some(t=>t.function.name==='employee_delegate'),'specialists cannot spawn recursive teams');
   if(holdChild){childEntered=true;await new Promise(r=>releaseChild=r);}
   if(blockChild)response={content:'',tool_calls:[call('block','report_blocker',{blocker:'Fixture asset is missing',next_action:'Provide the fixture asset',summary:'Independent checks finished; asset needed.'})]};
   else{completedChildren++;response={content:'Verified delegated output and saved evidence.'};}
  }else{
   managerCalls++;assert.ok(body.tools.some(t=>t.function.name==='employee_delegate'));
   if(user.includes('Follow up with a manager status review'))response={content:'Manager follow-up verified.'};
   else if(!body.messages.some(m=>m.role==='tool'))response={content:'Calling two specialists.',tool_calls:[
    call('engineer','employee_delegate',{employee_id:roster.find(e=>e.role==='Engineer').id,request_key:'engineer-task',title:'Build scoped output',instruction:'Build only the assigned fixture output and verify it.'}),
    call('designer','employee_delegate',{employee_id:roster.find(e=>e.role==='Designer').id,request_key:'designer-task',title:'Review separate visual output',instruction:'Review the independent visual fixture and return evidence.'}),
    call('wait','employee_wait',{})]};
   else{if(!blockChild)assert.equal(completedChildren,2,'manager resumes only after both employees finish');response={content:'Reviewed the employee results and verified the combined outcome.'};}
  }
  return Response.json({choices:[{message:response}]});
 }});
 let db;
 try{
  const p=await f.project('Manager QA','Team delegation');
  await f.api('/api/account/ai-providers/kimi',{method:'PUT',body:{token:'fixture-token-123456789'}});await f.api('/api/account/ai-providers/kimi/activate',{method:'POST'});
  roster=(await f.api(`/api/boards/${p.project.id}/employees`)).employees;assert.equal(roster.length,4);assert.equal(roster[0].role,'Manager');
  const assign=async()=>{const card=await f.api(`/api/lists/${p.list.id}/cards`,{method:'POST',body:{title:'Complete the authorized managed task'}});return{card,...await f.api(`/api/boards/${p.project.id}/employees/assign`,{method:'POST',body:{employee_id:roster[0].id,card_id:card.id,instruction:'Call two employees, wait, then verify their combined result.'}})};};
  const run=await assign();
  await until(async()=>{const r=await f.api(`/api/chat/threads/${run.thread_id}`);return r.job.status==='completed';});
  assert.equal(managerCalls,2);assert.equal(completedChildren,2);
  let team=await f.api(`/api/boards/${p.project.id}/employees`);
  const children=team.assignments.filter(a=>a.parent_job_id===run.job_id);assert.equal(children.length,2);assert.ok(children.every(c=>c.status==='completed'&&c.parent_card_id===run.card.id));
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  db.prepare("UPDATE project_employees SET role='Coordinator' WHERE id=?").run(roster[0].id);
  const employees=require('../server/project-employees').createProjectEmployees({db,ownerId:'user_owner',clean:(_,s)=>s});
  assert.equal(employees.ensure(p.project.id).length,4);assert.equal(employees.ensure(p.project.id)[0].id,roster[0].id);assert.equal(employees.ensure(p.project.id)[0].role,'Manager','migration keeps the original Morgan ID');
  const saved=JSON.parse(db.prepare('SELECT input_json FROM chat_run_checkpoints WHERE job_id=?').get(run.job_id).input_json);
  assert.equal(saved.filter(x=>x.type==='function_call_output'&&x.call_id==='engineer').length,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM employee_waits').get().n,0);
  db.prepare("UPDATE chat_jobs SET status='running' WHERE id=?").run(run.job_id);
  const args={employee_id:roster.find(e=>e.role==='Engineer').id,request_key:'engineer-task',title:'Build scoped output',instruction:'Build only the assigned fixture output and verify it.'};
  assert.equal(employees.delegate(run.job_id,args).job_id,children.find(c=>c.role==='Engineer').job_id,'replayed delegation returns the same job');
  assert.throws(()=>employees.delegate(run.job_id,{...args,title:'Different work'}),/different assignment/);
  assert.throws(()=>employees.delegate(children[0].job_id,args),/Only the assigned/);
  const other=await f.project('Manager isolation','Other project');const foreign=(await f.api(`/api/boards/${other.project.id}/employees`)).employees.find(e=>e.role==='Engineer');
  assert.throws(()=>employees.delegate(run.job_id,{...args,employee_id:foreign.id}),/in this project/);
  assert.throws(()=>employees.delegate(run.job_id,{...args,employee_id:roster[0].id}),/specialist/);
  db.prepare("UPDATE chat_jobs SET status='completed' WHERE id=?").run(run.job_id);
  // A terminal child blocker cannot be silently promoted to overall completion.
  blockChild=true;const blocked=await assign();await until(async()=>{const r=await f.api(`/api/chat/threads/${blocked.thread_id}`);return r.job.status==='blocked'&&/asset is missing/.test(r.job.blocker);});blockChild=false;
  // Cancellation while waiting cancels the running child and queued sibling too.
  holdChild=true;const stopped=await assign();await until(()=>childEntered);
  const waiting=await f.api(`/api/chat/threads/${stopped.thread_id}`);assert.equal(waiting.job.queue.reason,'employees');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chat_jobs WHERE status='running'").get().n,1,'waiting manager consumes no slot');
  const reopened=require('../server/project-employees').createProjectEmployees({db,ownerId:'user_owner',clean:(_,s)=>s});reopened.settle();assert.ok(db.prepare('SELECT 1 FROM employee_waits WHERE job_id=?').get(stopped.job_id),'durable wait survives service reconstruction');
  await f.api(`/api/chat/jobs/${stopped.job_id}/cancel`,{method:'POST'});holdChild=false;releaseChild();
  await until(()=>!db.prepare("SELECT 1 FROM chat_jobs WHERE status IN ('running','queued')").get());
  team=await f.api(`/api/boards/${p.project.id}/employees`);assert.ok(team.assignments.filter(a=>a.job_id===stopped.job_id||a.parent_job_id===stopped.job_id).every(a=>a.status==='cancelled'));
  const follow=await f.api(`/api/chat/threads/${run.thread_id}/messages`,{method:'POST',body:{mode:'work',content:'Follow up with a manager status review.'}});
  await until(async()=>{const r=await f.api(`/api/chat/threads/${run.thread_id}`);return r.job.id===follow.id&&r.job.status==='completed';});
  assert.equal(employees.forJob(follow.id).employee_id,roster[0].id,'Work replies retain the assigned manager identity');
  console.log('PASS: one-slot manager delegation, parallel-ready scoped children, durable wait/review, stable-key replay, recursion/tenant rejection, blocked-child propagation and cancellation cascade');
 }finally{releaseChild?.();await pause(50);db?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
