const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {cost}=require('../server/ai-rates');
const {workspacePath}=require('../server/cloud');
const Database=require('better-sqlite3');
const key='sk-fixture_'+crypto.randomBytes(24).toString('hex'),platformKey='sk-platform_'+crypto.randomBytes(24).toString('hex');
const response=output=>({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,input_tokens_details:{cached_tokens:20,cache_write_tokens:10},output_tokens:50},output});
const call=(name,args)=>({type:'function_call',id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),name,arguments:JSON.stringify(args)});
const answer=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
async function run(){
 assert.equal(cost(response([])).nano,3345000);
 assert.equal(cost({...response([]),usage:{input_tokens:300000,input_tokens_details:{cached_tokens:10000,cache_write_tokens:20000},output_tokens:1000}}).nano,5995000000);
 assert.throws(()=>cost({...response([]),model:'unpriced-model'}));assert.throws(()=>cost({...response([]),service_tier:'priority'}));assert.throws(()=>cost({...response([]),usage:{input_tokens:10,input_tokens_details:{cached_tokens:11},output_tokens:1}}));
 let requests=[],mode='normal',resolveNetwork,secretCard,step=0;
 const fake=async(url,opts)=>{
  if(url.includes('/models/')){assert.equal(opts.headers.Authorization,'Bearer '+key);return Response.json({id:'gpt-6-astra'});}
  assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(opts.headers.Authorization,'Bearer '+key);const body=JSON.parse(opts.body);requests.push(body);assert.equal(body.store,false);assert.ok(!opts.body.includes(key));
  if(mode==='wait')await new Promise(r=>resolveNetwork=r);
  if(mode==='timeout')throw Error('network lost');
  const outputs=step++===0?[call('get_project',{})]:step===2?[call('read_task',{id:secretCard}),call('save_file',{name:'deliverable.txt',content:'Saved inside the authorized project.'})]:[answer('Saved deliverable.txt in this project.')];
  return Response.json(response(outputs));
 };
 const f=await fixture({providerRequest:fake});try{
  const a=await f.project('Shared','Project'),b=await f.project('Secret','Private');secretCard=(await f.api(`/api/lists/${b.list.id}/cards`,{method:'POST',body:{title:'PRIVATE_UNIQUE_CONTEXT'}})).id;
  const added=await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'ai@example.com',role:'editor'}}),user=added.member.user_id;
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:20,api_key:key}});
  assert.equal((await f.api('/api/ai/settings')).has_key,true);assert.equal((await f.api('/api/ai/settings',{user})).has_key,false);
  const thread=await f.api(`/api/boards/${a.project.id}/chat/threads`,{user,method:'POST',body:{title:'Owner funded API test'}});
  await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{ mode:'work', content:'Read this project and save a deliverable.'}});
  let chat;for(let i=0;i<100;i++){chat=await f.api(`/api/chat/threads/${thread.id}`,{user});if(!['queued','running'].includes(chat.job.status))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(chat.job.status,'completed',JSON.stringify(chat));assert.equal(chat.messages.at(-1).content,'Saved deliverable.txt in this project.');assert.equal(chat.job.activity.length,3);
  assert.ok(JSON.stringify(requests).includes('Task not found in this project'));assert.ok(!JSON.stringify(requests).includes('PRIVATE_UNIQUE_CONTEXT'));assert.ok(!JSON.stringify(chat).includes(key));
  const files=await f.api(`/api/boards/${a.project.id}/files`,{user});assert.equal(files.files.length,1);assert.equal(await(await f.request(`/api/project-files/${files.files[0].id}/download`,{user})).text(),'Saved inside the authorized project.');
  assert.equal((await f.api('/api/ai/settings',{user})).usage.provider_cost,0);let summary=await f.api('/api/ai/settings');assert.equal(summary.usage.boardly_charge,0);assert.equal(summary.usage.provider_cost,0.010035);
  const disk=new Database(path.join(f.root,'personal-ai.db'));assert.ok(!JSON.stringify(disk.prepare('SELECT * FROM ai_accounts').all()).includes(key));disk.close();
  mode='wait';await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{ mode:'work', content:'Run after revocation'}});while(!resolveNetwork)await new Promise(r=>setTimeout(r,5));
  const grants=await f.api(`/api/projects/${a.project.id}/members`);await f.api(`/api/memberships/${grants.members[0].grant_id}`,{method:'DELETE'});resolveNetwork();
  await new Promise(r=>setTimeout(r,30));chat=await f.api(`/api/chat/threads/${thread.id}`);assert.equal(chat.job.status,'blocked');assert.equal((await f.request(`/api/chat/threads/${thread.id}`,{user})).status,403);
  console.log('PASS: encrypted owner-funded keys, zero member charges, scoped API tools, file output, visible activity, actual token costs, zero Boardly BYOK charges and in-flight access revocation');
 }finally{await f.close();}
 let paidCalls=0;const records=[],customers=new Map(),subs=new Map();let failMeter=true,networkFail=false;
 const billing={secretKey:'sk_test_stripe',webhookSecret:'whsec_fixture',serialPrice:'price_serial',agencyPrice:'price_agency',seatPrice:'price_seats',aiPrice:'price_ai'};
 const stripeFake=async(url,opts)=>{
  if(url.startsWith('https://api.openai.com/')){paidCalls++;assert.equal(opts.headers.Authorization,'Bearer '+platformKey);if(networkFail)throw Error('connection lost');return Response.json(response([answer('Card funded result.')]));}
  const u=new URL(url),body=new URLSearchParams(opts.body||u.search);records.push({route:u.pathname,body:Object.fromEntries(body),idempotency:opts.headers['Idempotency-Key']});
  if(u.pathname.endsWith('/customers')){const id='cus_'+customers.size;customers.set(body.get('metadata[boardly_user]'),id);return Response.json({id});}
  if(u.pathname.endsWith('/subscriptions'))return Response.json({data:subs.get(body.get('customer'))||[],has_more:false});
  if(u.pathname.endsWith('/meter_events')){if(failMeter){failMeter=false;return Response.json({error:{}},{status:500});}return Response.json({identifier:body.get('identifier')});}
  return Response.json({url:'https://checkout.stripe.com/c/pay/fixture'});
 };
 const g=await fixture({publicAccess:true,providerRequest:stripeFake,billing,openaiApiKey:platformKey});try{
  const user='user_payer',a=await g.project('Paying company','Paying project',user);
  await g.api('/api/billing/checkout',{user,method:'POST',body:{kind:'extra_users',quantity:2}});const cid=customers.get(user);
  subs.set(cid,[{id:'sub_seats',status:'active',items:{data:[{id:'si_seats',price:{id:'price_seats'},quantity:2}]}},{id:'sub_ai',status:'active',items:{data:[{price:{id:'price_ai'}}]}}]);
  assert.equal((await g.api('/api/account/plan',{user})).user_limit,3);
  for(const email of ['first@example.com','second@example.com'])await g.api(`/api/projects/${a.project.id}/members`,{user,method:'POST',body:{email,role:'editor'}});
  assert.equal((await g.request(`/api/projects/${a.project.id}/members`,{user,method:'POST',body:{email:'third@example.com',role:'editor'}})).status,409);
  assert.equal((await g.request('/api/ai/settings',{user,method:'PUT',body:{mode:'card',model:'gpt-6-astra',monthly_cap:20}})).status,400);
  assert.equal((await g.request('/api/ai/checkout',{user,method:'POST',body:{consent:true}})).status,410);
  const thread=await g.api(`/api/boards/${a.project.id}/chat/threads`,{user,method:'POST',body:{}});
  assert.equal((await g.request(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Use the platform AI account'}})).status,402);
  assert.equal(paidCalls,0,'An unconnected customer cannot spend the platform API key');
  assert.equal(records.filter(r=>r.route.endsWith('/meter_events')).length,0);
  subs.set(cid,[]);assert.equal((await g.api('/api/account/plan',{user})).user_limit,1);
  const raw=JSON.stringify({id:'evt_fixture',type:'invoice.paid',data:{object:{}}}),stamp=String(Math.floor(Date.now()/1000)),sig=crypto.createHmac('sha256',billing.webhookSecret).update(stamp+'.'+raw).digest('hex');
  assert.equal((await fetch(g.base+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${stamp},v1=${sig}`},body:raw})).status,200);
  assert.equal((await fetch(g.base+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${stamp},v1=${'0'.repeat(64)}`},body:raw})).status,400);
  console.log('PASS: paid extra-user quantities, BYO-only customer AI, no platform-key fallback, cancelled seat subscription gates and signed webhooks (provider fixtures; no real charges)');
 }finally{await g.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
