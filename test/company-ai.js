const assert=require('node:assert/strict'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const calls=[];let target,waitProvider=false,release,waiting=false;
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,options)=>{
  const provider=url.includes('moonshot')?'kimi':'deepseek',token=options.headers.Authorization;
  if(url.endsWith('/models'))return Response.json({data:[{id:provider+'-fast'},{id:provider+'-reasoning'}]});
  const body=JSON.parse(options.body);calls.push({provider,token,body});
  if(waitProvider&&provider==='deepseek'){waiting=true;await new Promise(r=>release=r);}
  const manager=body.tools?.some(t=>t.function.name==='delegate_company_work'),done=body.messages.some(m=>m.role==='tool');
  return Response.json({choices:[{message:manager&&!done?{content:null,tool_calls:[{id:'delegate-1',type:'function',function:{name:'delegate_company_work',arguments:JSON.stringify({company_id:target.company.id,board_id:target.project.id,assignment_key:'review',instruction:'Read this Board and report its name.'})}}]}:!manager&&!done?{content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'get_project',arguments:'{}'}}]}:{content:manager?'Delegated work; follow its Board job.':'Board read successfully.'}}],usage:{prompt_tokens:1,completion_tokens:1}});
 }});
 async function wait(fn){for(let i=0;i<200;i++){const value=await fn();if(value)return value;await pause(20);}throw Error('Timed out');}
 async function work(p){const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Read my Board.'}});return {thread:t,done:()=>wait(async()=>{const d=await f.api('/api/chat/threads/'+t.id);return d.job&&!['queued','running'].includes(d.job.status)?d:false;})};}
 try{
  const page=await fetch(f.base+'/app');assert.equal(page.status,200,'Public app shell must not require a tenant');assert.match(await page.text(),/<!doctype html>/i);
  const a=target=await f.project('Company A','Board A'),b=await f.project('Company B','Board B');
  const base=id=>`/api/companies/${id}/ai`,save=(id,body)=>f.api(base(id),{method:'PUT',body});
  await f.api('/api/account/ai-providers/kimi',{method:'PUT',body:{token:'organization-key'}});
  await f.api('/api/account/ai-providers/kimi/activate',{method:'POST'});
  assert.equal((await f.api(base(a.company.id))).effective.provider,'kimi');
  await f.api(base(a.company.id)+'/providers/deepseek',{method:'PUT',body:{token:'company-a-key'}});
  await f.api(base(b.company.id)+'/providers/deepseek',{method:'PUT',body:{token:'company-b-key'}});
  await save(a.company.id,{source:'company',provider:'deepseek',model:'deepseek-reasoning'});
  assert.equal((await f.api('/api/ai/settings')).provider,'kimi','Company selection must preserve Organization AI');
  const ca=await (await work(a)).done(),cb=await (await work(b)).done();
  assert.equal(ca.job.status,'completed');assert.equal(cb.job.status,'completed');
  assert.ok(calls.some(c=>c.token==='Bearer company-a-key'&&c.body.model==='deepseek-reasoning'));
  assert.ok(calls.some(c=>c.token==='Bearer organization-key'&&c.body.model==='kimi-fast'));
  assert.ok(!calls.some(c=>c.token==='Bearer company-b-key'),'An unused company connection stays inactive');
  assert.equal((await f.request(base(a.company.id),{method:'PUT',body:{source:'company',provider:'deepseek',model:'invented'}})).status,400);
  await save(b.company.id,{source:'organization',provider:'kimi',model:'kimi-reasoning'});
  await (await work(b)).done();assert.equal(calls.at(-1).body.model,'kimi-reasoning');
  assert.equal((await f.api('/api/ai/settings')).model,'kimi-fast');
  const manager=await f.api('/api/agents/organization/0/threads',{method:'POST',body:{}});
  await f.api('/api/discussions/threads/'+manager.id+'/messages',{method:'POST',body:{mode:'work',content:'Ask Company A to read Board A.'}});
  const org=await wait(async()=>{const d=await f.api('/api/discussions/threads/'+manager.id);return d.runs[0]?.status==='completed'?d:false;});
  assert.equal(org.runs[0].delegations.length,1);assert.equal(org.runs[0].delegations[0].ai.provider,'deepseek');
  await wait(async()=>{const d=await f.api('/api/discussions/threads/'+manager.id);return d.runs[0].delegations[0].status==='completed';});
  assert.equal(calls.at(-1).token,'Bearer company-a-key');
  // Company override works even when the Organization connection is disconnected.
  await f.api('/api/account/ai-providers/kimi',{method:'DELETE'});
  assert.equal((await (await work(a)).done()).job.status,'completed');
  const member=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'ai-member@example.com'}})).member.user_id;
  for(const route of [base(a.company.id),'/api/agents/organization/0'])assert.equal((await f.request(route,{user:member,workspace:'user_owner'})).status,403);
  assert.equal((await f.request(base(a.company.id),{user:member,workspace:'user_owner',method:'PUT',body:{source:'inherit'}})).status,403);
  assert.equal((await f.request(base(a.company.id),{user:'user_foreign'})).status,404);
  assert.ok(!JSON.stringify(await f.api(base(a.company.id))).includes('company-a-key'));
  const db=new Database(path.join(f.root,'personal-ai.db'),{readonly:true});
  const rows=db.prepare("SELECT * FROM ai_provider_connections WHERE provider='deepseek'").all();db.close();assert.equal(rows.length,2);assert.ok(rows.every(r=>!r.encrypted.includes('company-')));assert.notEqual(rows[0].user_id,rows[1].user_id);
  waitProvider=true;const pending=await work(a);await wait(()=>waiting);
  await save(a.company.id,{source:'inherit'});waitProvider=false;release();
  assert.equal((await pending.done()).job.status,'blocked','Revocation prevents a stale response from executing tools');
  console.log('PASS: Organization inheritance; isolated company keys; model overrides; Organization delegation; independent company execution; member/tenant isolation; in-flight policy revocation.');
 }finally{release?.();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
