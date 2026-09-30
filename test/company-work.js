const assert=require('node:assert/strict');
const {fixture}=require('./member-fixture');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const blueprint={request_key:'launch-team',departments:[
  {name:'Marketing',description:'Reach the first customers',boards:[{name:'Campaigns',description:'Launch plan',tasks:[{title:'Draft launch plan',description:'Prepare a draft, without publishing or spending.'}]}]},
  {name:'Operations',description:'Deliver the service',boards:[{name:'Delivery',description:'Service process',tasks:[{title:'Write delivery checklist',description:'Document the workflow.'}]}]}
]};
(async()=>{
 let company,foreign,setup,assignment,round=0;const results=[],requests=[];
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-test'}]});
  const body=JSON.parse(options.body);requests.push({body,token:options.headers.Authorization});
  const tool=(name,args)=>({content:null,tool_calls:[{id:'call-'+round,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  let message;
  if(body.tools?.some(t=>t.function.name==='build_company_structure')){
   const outputs=body.messages.filter(m=>m.role==='tool');
   if(outputs.length)results.push(JSON.parse(outputs.at(-1).content));
   round++;
   if(round===1)message=tool('read_company_structure',{});
   if(round===2)message=tool('build_company_structure',blueprint);
   if(round===3){setup=results.at(-1);message=tool('build_company_structure',blueprint);}
   if(round===4)message=tool('build_company_structure',{...blueprint,departments:[...blueprint.departments,{name:'Duplicate mistake',description:'',boards:[]}]});
   if(round===5)message=tool('delegate_company_work',{company_id:foreign.company.id,board_id:foreign.project.id,card_id:1,assignment_key:'wrong-company',instruction:'Do not execute'});
   if(round===6){const board=setup.departments[0].boards[0];assignment={company_id:company.id,board_id:board.id,card_id:board.tasks[0].id,assignment_key:'launch-plan',instruction:'Read the task and draft its launch plan. Do not publish.'};message=tool('delegate_company_work',assignment);}
   if(round===7)message=tool('delegate_company_work',assignment);
   if(round===8)message=tool('read_company_structure',{});
   if(round>=9)message={content:'Created two departments and Boards, each with a four-person AI team. The launch task is assigned; execution status is available below.'};
  }else if(body.tools?.length){
   message=body.messages.some(m=>m.role==='tool')?{content:'Reviewed the assigned task. Draft launch plan prepared; no publishing.'}:tool('get_project',{});
  }else message={content:'Here is the proposed company plan. No changes made.'};
  return Response.json({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1}});
 }});
 const post=(route,body)=>f.api(route,{method:'POST',body});
 const wait=async fn=>{for(let i=0;i<250;i++){const value=await fn();if(value)return value;await pause(20);}throw Error('Company work timed out');};
 try{
  company=await post('/api/companies',{name:'Empty company'});foreign=await f.project('Other company','Existing Board');
  await f.api(`/api/companies/${company.id}/ai/providers/deepseek`,{method:'PUT',body:{token:'company-work-test-key'}});
  await f.api(`/api/companies/${company.id}/ai`,{method:'PUT',body:{source:'company',provider:'deepseek',model:'deepseek-test'}});
  const thread=await post(`/api/agents/company/${company.id}/threads`,{});
  await post(`/api/discussions/threads/${thread.id}/messages`,{mode:'work',content:'Build Marketing and Operations departments with Boards, tasks and AI teams. Assign the launch planning task to its manager.'});
  const done=await wait(async()=>{const d=await f.api('/api/discussions/threads/'+thread.id);return d.runs[0]?.status==='completed'?d:false;});
  assert.equal(done.runs[0].delegations.length,1);
  assert.deepEqual(setup.created,{departments:2,boards:2,tasks:2});
  assert.equal(results[2].replayed,true);
  assert.match(results[3].error,/different setup/);
  assert.match(results[4].error,/inside this Company/);
  assert.equal(results[5].job_id,results[6].job_id,'Retry must reuse the manager assignment');
  const hierarchy=await f.api('/api/hierarchy');
  assert.equal(hierarchy.boards.filter(b=>b.company_id===company.id).length,2);
  assert.equal(hierarchy.projects.length,3,'Setup retry must not duplicate Boards');
  for(const department of setup.departments){
   const board=department.boards[0],team=await f.api(`/api/boards/${board.id}/employees`);
   assert.deepEqual(team.employees.map(e=>e.role),['Manager','Engineer','Designer','Reviewer']);
   assert.equal(team.team.enabled,0,'A finite setup must not turn on continuous backlog execution');
   if(department.name==='Marketing'){assert.equal(team.assignments.length,1);assert.equal(team.assignments[0].role,'Manager');assert.equal(team.assignments[0].card_id,board.tasks[0].id);}
   else assert.equal(team.assignments.length,0,'Unrequested execution must remain unstarted');
  }
  assert.ok(requests.every(r=>r.token==='Bearer company-work-test-key'),'Company selection must fund both planner and worker');
  await wait(async()=>{const d=await f.api('/api/discussions/threads/'+thread.id);return !['queued','running'].includes(d.runs[0].delegations[0].status);});
  for(const mode of ['ask','plan']){
   const t=await post(`/api/agents/company/${company.id}/threads`,{});
   await post(`/api/discussions/threads/${t.id}/messages`,{mode,content:'What team should we have?'});
   await wait(async()=>{const d=await f.api('/api/discussions/threads/'+t.id);return d.runs[0]?.status==='completed';});
   assert.equal(requests.at(-1).body.tools?.length||0,0);
  }
  const member=(await post(`/api/companies/${company.id}/members`,{email:'company-work-member@example.com'})).member.user_id;
  const denied=await f.request(`/api/discussions/threads/${thread.id}/messages`,{user:member,workspace:'user_owner',method:'POST',body:{mode:'work',content:'Build another team'}});
  assert.equal(denied.status,403);
  assert.equal((await f.request(`/api/discussions/threads/${thread.id}`,{user:'user_foreign'})).status,404);
  console.log('PASS: empty company -> departments, Boards, tasks, employee teams and one Manager assignment; exact retries; conflict and cross-company rejection; company AI inheritance; no unsolicited execution; Ask/Plan read-only; member/tenant isolation.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
