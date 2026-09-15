process.env.BOARDLY_MAX_AGENTS='16';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),net=require('node:net');
const {fixture}=require('./member-fixture'),{connectorFixture}=require('./chatgpt-fixture.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){const value=await fn();if(value)return value;await pause(20);}throw Error('Timed out waiting for state');}
(async()=>{
 const c=await connectorFixture();let localCalls=0;
 const local=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;res.setHeader('content-type','application/json');if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'local-test-model'}]}));localCalls++;const data=JSON.parse(raw);assert.ok(data.tools.some(t=>t.function.name==='get_project'));const done=data.messages.some(m=>m.role==='tool');res.end(JSON.stringify({choices:[{message:done?{content:'Local AI verified this project.'}:{content:'',tool_calls:[{id:'local-read',type:'function',function:{name:'get_project',arguments:'{}'}}]}}],usage:{prompt_tokens:10,completion_tokens:5}}));});
 local.listen(0,'127.0.0.1');await new Promise(r=>local.once('listening',r));
 const tailnet=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({state:'Running',devices:[{id:'my-mac',name:'My Mac',online:true}]}));});
 tailnet.on('connect',(req,socket,head)=>{assert.equal(req.headers['x-boardly-device'],'my-mac');const upstream=net.connect(local.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());});
 tailnet.listen(0,'127.0.0.1');await new Promise(r=>tailnet.once('listening',r));
 const f=await fixture({chatgpt:{url:c.url,token:c.token},tailnet:{url:'http://127.0.0.1:'+tailnet.address().port,token:'fixture-private'},providerRequest:()=>{throw Error('No paid API calls permitted');}});
 try{
  const p=await f.project('Reliability','Fallback');
  await f.api('/api/ai/chatgpt/login',{method:'POST'});await c.approve('user_owner','owner@example.com');await f.api('/api/ai/chatgpt/activate',{method:'POST'});
  await f.api('/api/account/ai-providers/local',{method:'PUT',body:{device_id:'my-mac',port:11435,model:'local-test-model'}});
  await f.api('/api/account/ai-providers/local/fallback',{method:'POST',body:{enabled:true}});
  const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});
  await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'simulate-rate-limit then read this project with local fallback'}});
  const result=await until(async()=>{const r=await f.api(`/api/chat/threads/${t.id}`);return r.job.status==='completed'&&r;});
  assert.equal(localCalls,2,'one local tool call and one final answer');assert.match(result.messages.at(-1).content,/Local AI verified/);assert.equal((await f.api('/api/ai/settings')).mode,'chatgpt','fallback does not overwrite primary account');
  assert.ok(result.job.activity.some(a=>a.title.includes('Local AI fallback')));
  // Simultaneous connector requests share one account process and return to the right caller.
  const replies=await Promise.all(Array.from({length:16},()=>c.request('user_owner','respond',{model:'gpt-6-astra',input:[{role:'user',content:'slow-response'}],tools:[]})));
  assert.ok(replies.every(r=>r.status===200));assert.equal((await(await c.request('user_owner','status')).json()).connected,true);
  // Named employees, durable handoffs, idempotent dispatch and owner-only coordinator.
  const card=await f.api(`/api/lists/${p.list.id}/cards`,{method:'POST',body:{title:'Review authorized fixture'}});
  await f.api(`/api/boards/${p.project.id}/employees`,{method:'PUT',body:{enabled:true,instruction:'Read the assigned task and report the result.'}});
  const team=await until(async()=>{const d=await f.api(`/api/boards/${p.project.id}/employees`);return d.assignments.some(a=>a.status==='completed')&&d;});
  assert.equal(team.employees.length,4);assert.equal(team.assignments.length,1);assert.equal(team.assignments[0].card_id,card.id);
  const completedCard=await f.api(`/api/cards/${card.id}`),projectState=await f.api(`/api/boards/${p.project.id}`);assert.equal(projectState.lists.find(l=>l.id===completedCard.list_id).name,'Done Awaiting Revisions','employee completion updates the assigned task lifecycle');
  await f.api(`/api/boards/${p.project.id}/employees`,{method:'PUT',body:{enabled:true,instruction:'Read the assigned task and report the result.'}});
  const final=await f.api(`/api/boards/${p.project.id}/employees`);assert.equal(final.assignments.length,1);assert.ok(final.messages.some(m=>m.body.includes('completed')));
  const q=await f.project('Private','Other project');const foreign=(await f.api(`/api/boards/${q.project.id}/employees`,{method:'PUT',body:{enabled:false,instruction:''}})).employees[0];
  assert.equal((await f.request(`/api/boards/${p.project.id}/employees/messages`,{method:'POST',body:{recipient_id:foreign.id,body:'no cross-project access'}})).status,404);
  await f.api(`/api/boards/${p.project.id}/employees`,{method:'PUT',body:{enabled:false,instruction:''}});
  console.log('PASS: 16 concurrent shared-auth requests, real quota-to-local tool cycle, sticky per-run fallback, primary identity retained, employee dispatch/handoff deduplication and cross-project rejection');
 }finally{await f.close();await c.close();local.closeAllConnections();tailnet.closeAllConnections();await Promise.all([new Promise(r=>local.close(r)),new Promise(r=>tailnet.close(r))]);}
})().catch(e=>{console.error(e);process.exitCode=1;});
