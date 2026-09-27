const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const Database=require('better-sqlite3');
const path=require('node:path');
const {fixture}=require('./member-fixture');
const {baseURL,publicAddress,createOpenWebUIRequest}=require('../server/openwebui');
const {createBilling}=require('../server/customer-billing');
(async()=>{
 for(const url of ['http://host.test','https://user:key@host.test','https://host.test/?key=secret','https://host.test/#key','https://host.test/playground','https://host.test/%2fapi'])assert.throws(()=>baseURL(url),{status:400});
 assert.equal(baseURL('https://models.example.com/prefix/api/'),'https://models.example.com/prefix');
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2002:7f00:1::','2001:db8::1'])assert.equal(publicAddress(address),false,address);
 for(const address of ['1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
 let dialed=0,pinned,redirect=false;
 const request=(url,options,callback)=>{
  dialed++;assert.equal(url.href,'https://models.example.com/api/models');assert.equal(options.agent,false);assert.equal(options.headers.Authorization,'Bearer fixture-private');
  options.lookup(url.hostname,{all:true},(_,addresses)=>pinned=addresses);
  const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=redirect?302:200;res.headers={location:'https://evil.example'};callback(res);res.end(JSON.stringify({data:[{id:'model'}]}));};req.destroy=()=>{};return req;
 };
 const c={base_url:'https://models.example.com',token:'fixture-private'};
 const transport=createOpenWebUIRequest({resolve:async()=>[{address:'1.1.1.1',family:4}],request});
 assert.equal((await transport(c,'/api/models')).status,200);assert.deepEqual(pinned,[{address:'1.1.1.1',family:4}]);
 redirect=true;await assert.rejects(()=>transport(c,'/api/models'),{status:400});assert.equal(dialed,2);
 const mixed=createOpenWebUIRequest({resolve:async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}],request});await assert.rejects(()=>mixed(c,'/api/models'),{status:400});assert.equal(dialed,2);
 const paid=new Set(['user_paid']),calls=[];let revokeDuringCall=false;
 const fake=async(connection,route,body)=>{
  calls.push({connection,route,body});assert.equal(connection.base_url,'https://models.example.com');assert.equal(connection.token,'fixture-paid-key');
  if(route==='/api/models')return Response.json({data:[{id:'tools-model'}]});
  assert.equal(route,'/api/chat/completions');assert.equal(body.stream,false);
  if(revokeDuringCall)paid.delete('user_paid');
  const tool=body.messages.find(m=>m.role==='tool');
  return Response.json({choices:[{message:tool?{role:'assistant',content:'I read your project with the approved tool.'}:{role:'assistant',content:null,tool_calls:[{id:'call_owui',type:'function',function:{name:'get_project',arguments:'{}'}}]}}],usage:{prompt_tokens:12,completion_tokens:3}});
 };
 const f=await fixture({publicAccess:true,openWebUIRequest:fake});
 f.identity.billing.getUserBillingSubscription=async user=>({subscriptionItems:paid.has(user)?[{status:'active',periodEnd:Date.now()+600000,plan:{slug:'serial_entrepreneur'}}]:[]});
 const route='/api/account/ai-providers/openwebui',user='user_paid',body={base_url:'https://models.example.com',token:'fixture-paid-key'};
 try {
  assert.equal((await f.request(route,{user:'user_free',method:'PUT',body:{...body,user_id:user}})).status,402);assert.equal(calls.length,0);
  await f.api(route,{user,method:'PUT',body});
  assert.equal((await f.api('/api/ai/settings',{user})).mode,'none');
  const state=await f.api('/api/account/ai-providers',{user});assert.equal(state.openwebui_available,true);assert.ok(!JSON.stringify(state).includes(body.token));
  assert.equal((await f.api('/api/account/ai-providers',{user:'user_other'})).connections.find(c=>c.provider==='openwebui').saved,false);
  assert.equal((await f.request(route,{user,method:'PUT',body:{base_url:'https://different.example.com'}})).status,400,'Never forward saved key to another server');
  await f.api(route+'/activate',{user,method:'POST'});
  const p=await f.project('WebUI company','WebUI tool project',user),thread=await f.api(`/api/boards/${p.project.id}/chat/threads`,{user,method:'POST',body:{}});
  const wait=async()=>{for(let i=0;i<200;i++){const t=await f.api(`/api/chat/threads/${thread.id}`,{user});if(t.job&&!['running','queued'].includes(t.job.status))return t;await new Promise(r=>setTimeout(r,15));}throw Error('Timed out');};
  await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Read my project'}});
  const done=await wait();assert.equal(done.job.status,'completed',JSON.stringify(done.job));assert.match(done.messages.at(-1).content,/approved tool/);assert.ok(calls.some(c=>c.body?.messages.some(m=>m.role==='tool')));
  const db=new Database(path.join(f.root,'personal-ai.db'),{readonly:true});assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_provider_connections').all()).includes(body.token));db.close();
  const ownerProject=await f.project('Owner company');
  const member=(await f.api(`/api/companies/${ownerProject.company.id}/members`,{method:'POST',body:{email:'member@example.com'}})).member.user_id;
  assert.equal((await f.request(route+'/activate',{user:member,workspace:'user_owner',method:'POST'})).status,403);
  paid.delete(user);const before=calls.length;
  assert.equal((await f.request(route+'/activate',{user,method:'POST'})).status,402);
  assert.equal((await f.request(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'No access'}})).status,402);assert.equal(calls.length,before);
  paid.add(user);revokeDuringCall=true;
  await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Revoke during response'}});
  assert.equal((await wait()).job.status,'blocked');
  await f.api(route,{user,method:'DELETE'}); // expired customers can remove credentials
 } finally {await f.close();}
 const db=new Database(':memory:');let subscriptions=[];
 const billing=createBilling({db,config:{ownerId:'owner',origin:'https://boardly.example',billing:{secretKey:'fixture',serialPrice:'price_plan',voicePrices:['price_voice']}},request:async()=>Response.json({data:subscriptions,has_more:false})});
 db.prepare('INSERT INTO billing_customers VALUES (?,?)').run('paid','cus_paid');
 const sub=(status,price='price_plan',end=Date.now()/1000+300)=>({status,items:{data:[{price:{id:price},quantity:1,current_period_end:end}]}});
 for(const status of ['trialing','past_due','canceled','unpaid','incomplete','paused']){subscriptions=[sub(status)];assert.equal(await billing.paidAccess('paid'),false,status);}
 subscriptions=[sub('active','price_voice')];assert.equal(await billing.paidAccess('paid'),true);assert.equal(await billing.paidAccess('other'),false);
 subscriptions=[sub('active','unknown')];assert.equal(await billing.paidAccess('paid'),false);
 subscriptions=[sub('active','price_plan',1)];assert.equal(await billing.paidAccess('paid'),false);
 assert.equal(await billing.paidAccess('owner'),true);db.close();
 console.log('PASS: Open WebUI scoped tool cycle, paid/free/member isolation, encrypted keys, subscription revocation, disconnect, configured paid add-ons, HTTPS/SSRF/DNS pinning and redirect protection.');
})().catch(e=>{console.error(e);process.exitCode=1;});
