const assert=require('node:assert/strict'),crypto=require('node:crypto'),Database=require('better-sqlite3'),path=require('node:path');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const base='/api/company-onboarding',uuid=()=>crypto.randomUUID();
(async()=>{
 let calls=0,answer={reply:'Who should we help first?',suggestions:['Local shops'],brief:{name:'Bright Ideas',audience:'Local shops'},projects:[{name:'Marketing',description:'First month',tasks:[{title:'Interview five shop owners',description:'Validate the problem before buying ads.'}]}]};
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,opts)=>{if(url.endsWith('/models'))return Response.json({data:[{id:'claude-test'}]});calls++;const body=JSON.parse(opts.body);assert.ok(!body.tools?.length);return Response.json({content:[{type:'text',text:typeof answer==='string'?answer:JSON.stringify(answer)}],usage:{input_tokens:10,output_tokens:20}});}});
 const api=(p,body,user='user_owner',method='POST')=>f.api(base+p,{user,method,body});
 const wait=async(id,user='user_owner')=>{for(let i=0;i<200;i++){const d=await api('/drafts/'+id,undefined,user,'GET');if(!d.turns.some(t=>['queued','running'].includes(t.status)))return d;await new Promise(r=>setTimeout(r,10));}throw Error('Reply timed out');};
 try{
  const id=uuid(),q={request_id:id,brief:{name:'Quick company',website:'https://example.com'}};
  const one=await api('/quick',q),again=await api('/quick',q);assert.equal(one.company.id,again.company.id);assert.equal(calls,0);assert.equal((await f.api('/api/hierarchy')).projects.length,0);
  assert.match(one.company.description,/https:\/\/example.com/);
  const d=await api('/drafts',{request_id:uuid()});assert.equal((await f.api('/api/hierarchy')).companies.length,1);
  const d2=await api('/drafts/'+d.id,{version:d.version,brief:{name:'Saved idea',description:'User edit'},projects:[]},'user_owner','PUT');
  assert.equal((await f.request(base+'/drafts/'+d.id,{method:'PUT',body:{version:d.version,brief:{},projects:[]}})).status,409);
  assert.equal((await f.request(base+'/drafts/'+d.id,{user:'user_foreign'})).status,404);
  await f.api('/api/account/ai-providers/claude',{method:'PUT',body:{token:'test-key-company-private-123456'}});await f.api('/api/account/ai-providers/claude/activate',{method:'POST'});
  const msg={client_id:uuid(),version:d2.version,content:'I want a marketing plan for local shops'};
  await Promise.all([api('/drafts/'+d.id+'/messages',msg),api('/drafts/'+d.id+'/messages',msg)]);
  let ready=await wait(d.id);assert.equal(calls,1);assert.equal(ready.turns.length,1);assert.equal(ready.brief.description,'User edit');assert.equal(ready.projects.length,1);
  assert.equal((await f.api('/api/hierarchy')).projects.length,0,'Chat must not create projects before review');
  assert.equal((await f.request(base+'/drafts/'+d.id+'/create',{method:'POST',body:{version:ready.version}})).status,400);
  const reviewed={version:ready.version,reviewed:true,brief:{...ready.brief,name:'Reviewed company'},projects:ready.projects};
  const results=await Promise.all([api('/drafts/'+d.id+'/create',reviewed),api('/drafts/'+d.id+'/create',reviewed)]);assert.equal(results[0].company.id,results[1].company.id);
  const tree=await f.api('/api/hierarchy');assert.equal(tree.companies.length,2);assert.equal(tree.projects.length,1);const full=await f.api('/api/boards/'+tree.projects[0].id);assert.equal(full.lists[0].cards.length,1);assert.ok(full.lists.some(l=>l.name==='Done Awaiting Revisions'));
  const existing=await api('/drafts',{request_id:uuid(),company_id:one.company.id});await api('/drafts/'+existing.id+'/create',{version:existing.version,reviewed:true,brief:existing.brief,projects:ready.projects});assert.equal((await f.api('/api/hierarchy')).companies.length,2);
  const member=(await f.api(`/api/companies/${one.company.id}/members`,{method:'POST',body:{email:'member@company.test'}})).member.user_id;
  assert.equal((await f.request(base,{user:member,workspace:'user_owner'})).status,403);
  const free=await api('/drafts',{request_id:uuid()},'user_free');await api('/drafts/'+free.id+'/messages',{client_id:uuid(),content:'Keep this answer while I connect AI',version:free.version},'user_free');const paused=await wait(free.id,'user_free');assert.equal(paused.turns[0].status,'failed');assert.equal(paused.turns[0].prompt,'Keep this answer while I connect AI');assert.equal((await f.api('/api/hierarchy',{user:'user_free'})).companies.length,0);
  await api('/quick',{request_id:uuid(),brief:{name:'Free company'}},'user_free');assert.equal((await f.request(base+'/drafts/'+free.id+'/create',{user:'user_free',method:'POST',body:{version:paused.version,reviewed:true,brief:{name:'Second company'}}})).status,409);
  assert.equal((await f.request('/api/companies',{user:'user_free',method:'POST',body:{name:'Another company'}})).status,409);
  const bad=await api('/drafts',{request_id:uuid()});answer='broken JSON';await api('/drafts/'+bad.id+'/messages',{client_id:uuid(),content:'Bad AI reply',version:bad.version});const failed=await wait(bad.id);assert.equal(failed.turns[0].status,'failed');assert.deepEqual(failed.projects,[]);answer={reply:'Try again',brief:{name:'Recovered'},projects:[]};await Promise.all([api('/drafts/'+bad.id+'/retry',{turn_id:failed.turns[0].id}),api('/drafts/'+bad.id+'/retry',{turn_id:failed.turns[0].id})]);const recovered=await wait(bad.id);assert.equal(recovered.turns.length,1);assert.equal(recovered.brief.name,'Recovered');assert.equal(calls,3);
  assert.equal((await f.request(base+'/quick',{method:'POST',body:{request_id:uuid(),brief:{name:'Unsafe link',website:'javascript:alert(1)'}}})).status,400);
  // Paid entitlements come from the same plan definitions used by billing.
  f.identity.billing.getUserBillingSubscription=async()=>({subscriptionItems:[{status:'active',plan:{slug:'serial_entrepreneur'}}]});
  // Owner and free remain as above; verify the service and its seat distinction separately.
  const {PLANS,createPlanService}=require('../server/account-plans');assert.equal(PLANS.basic.companies,1);assert.equal(PLANS.serial_entrepreneur.companies,null);assert.equal(PLANS.agency.companies,null);assert.equal(PLANS.serial_entrepreneur.users,5);assert.equal(PLANS.agency.users,300);assert.equal((await createPlanService(f.config,f.identity).sponsored('user_paid')).companies,null);
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'none',model:'gpt-6-astra',monthly_cap:20,api_key:''}});
  const conn=require('../server/connections').createConnections(f.root),worker=conn.issue('user_owner','Company builder test','worker');conn.close();
  const w=async(route,body)=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+worker.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  await w('/api/worker/claim',{cloud:true,subscription_bridge:true});const wd=await api('/drafts',{request_id:uuid()});await api('/drafts/'+wd.id+'/messages',{client_id:uuid(),version:wd.version,content:'Use my subscription to plan this company'});
  let job;for(let i=0;i<50;i++){job=(await w('/api/worker/claim',{cloud:true,subscription_bridge:true})).job;if(job)break;await new Promise(r=>setTimeout(r,10));}assert.equal(job.kind,'subscription');assert.deepEqual(job.payload.tools,[]);await w('/api/worker/subscriptions/'+job.id,{status:'completed',result:{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'Which customers should we help?',brief:{name:'Subscription draft'},projects:[]})}]}]}});assert.equal((await wait(wd.id)).brief.name,'Subscription draft');
  console.log('PASS: quick add, saved draft/answer, customer API, reviewed atomic plan creation, request deduplication, invalid AI recovery, workspace/member isolation and free/paid company entitlements');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
