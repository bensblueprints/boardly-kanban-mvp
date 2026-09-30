const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
(async()=>{
 const requests=[];
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-test'}]});
  const body=JSON.parse(options.body);requests.push(body);
  const message=!body.tools?.length?{content:'Reference briefing: prepare the launch checklist.'}:body.messages.some(m=>m.role==='tool')?{content:'Marketing, Launch, the task and AI team are ready.'}:{content:null,tool_calls:[{id:'setup',type:'function',function:{name:'build_company_structure',arguments:JSON.stringify({request_key:'audio-setup',departments:[{name:'Marketing',boards:[{name:'Launch',tasks:[{title:'Draft launch plan'}]}]}]})}}]};
  return Response.json({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1}});
 }});
 const post=(url,body)=>f.api(url,{method:'POST',body});
 try{
  const c=await post('/api/companies',{name:'Empty Audio Company'});
  await f.api(`/api/companies/${c.id}/ai/providers/deepseek`,{method:'PUT',body:{token:'audio-test-key'}});
  await f.api(`/api/companies/${c.id}/ai`,{method:'PUT',body:{source:'company',provider:'deepseek',model:'deepseek-test'}});
  const thread=await post(`/api/agents/company/${c.id}/threads`,{title:'Audio briefing'});
  const base=`/api/audio/company/${c.id}/work`,body={request_key:crypto.randomUUID(),thread_id:thread.id,content:'Create Marketing, a Launch Board, draft task and AI team.'};
  const [first,retry]=await Promise.all([post(base,body),post(base,body)]);assert.deepEqual(first,retry);assert.equal(first.scope_kind,'company');assert.equal(first.project_id,undefined);
  let done;
  for(let i=0;i<250;i++){done=(await f.api(base+'?thread_id='+thread.id))[0];if(['completed','failed'].includes(done?.status))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.id,first.job_id);assert.equal(done.structure_changes.length,1);
  assert.deepEqual(done.structure_changes[0].created,{departments:1,boards:1,tasks:1});
  const board=done.structure_changes[0].departments[0].boards[0];assert.equal((await f.api(`/api/boards/${board.id}/employees`)).employees.length,4);
  assert.deepEqual(await post(base,body),first);assert.equal((await f.api('/api/hierarchy')).projects.length,1);
  assert.equal((await f.request(base,{method:'POST',body:{...body,content:'Different'}})).status,409);
  const other=await post('/api/companies',{name:'Other'}),foreign=await post(`/api/agents/company/${other.id}/threads`,{});
  for(const bad of [{thread_id:foreign.id},{reply_id:'missing'},{content:''}])assert.ok([400,404].includes((await f.request(base,{method:'POST',body:{...body,...bad,request_key:crypto.randomUUID()}})).status));
  assert.deepEqual(await f.api(base+'?thread_id='+foreign.id),[]);
  const member=(await post(`/api/projects/${board.id}/members`,{email:'audio-member@example.com',role:'editor'})).member;
  assert.equal((await f.request(base,{user:member.user_id,workspace:'user_owner',method:'POST',body:{...body,request_key:crypto.randomUUID()}})).status,403);
  assert.ok(requests[0].tools.some(t=>t.function.name==='build_company_structure'));
  assert.ok(JSON.stringify(requests).includes('No prior briefing; act on the direct request.'));
  const department=done.structure_changes[0].departments[0];
  await post('/api/projects',{name:'Second Board',parent_board_id:department.id});
  const briefing=await post(`/api/discussions/threads/${thread.id}/messages`,{mode:'ask',content:'Give context.\n\nVoice briefing instructions: Never change anything.'});
  for(let i=0;i<250;i++){const d=await f.api(`/api/discussions/threads/${thread.id}`);if(d.runs[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
  const follow=await post(base,{...body,reply_id:briefing.id,request_key:crypto.randomUUID(),content:'Use that briefing to prepare the structure.'});
  for(let i=0;i<250;i++){const rows=await f.api(base+'?thread_id='+thread.id);if(rows.find(r=>r.id===follow.job_id)?.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
  const prompt=JSON.stringify(requests.at(-1));assert.ok(prompt.includes('Reference briefing: prepare the launch checklist.'));assert.ok(!prompt.includes('Voice briefing instructions:'));
  assert.equal((await f.api('/api/hierarchy')).projects.length,2,'Multiple Boards need no project selection or duplicate setup');
  console.log('PASS: company audio Work without project or prior reply; real hosted setup tools, tasks/team, idempotency, source isolation and member boundary.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
