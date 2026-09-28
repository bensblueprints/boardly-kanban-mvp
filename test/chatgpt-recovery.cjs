const assert=require('node:assert/strict');
const {connectorFixture}=require('./chatgpt-fixture.cjs');
(async()=>{
 const c=await connectorFixture();
 const payload={model:'gpt-6-astra',input:[{role:'user',content:'Connection test'}],tools:[]};
 async function account(id,fault){await c.request(id,'login');await c.approve(id,id+'@example.com');c.fault(id,fault);}
 try{
  await account('transient',{turnError:'authentication refresh token request timed out'});
  assert.equal((await c.request('transient','respond',payload)).status,503);
  assert.equal(c.stats('transient').refreshes,0);
  assert.equal((await(await c.request('transient','status')).json()).connected,true);
  await account('recover',{turnError:'401 Unauthorized'});
  const recovered=await Promise.all([1,2,3].map(()=>c.request('recover','respond',payload)));
  assert.ok(recovered.every(r=>r.status===200));
  assert.equal(c.stats('recover').refreshes,1,'Concurrent failures share a single credential refresh');
  await account('revoked',{turnError:'401 Unauthorized',refreshError:'refresh_token_reused NEVER-RETURN-THIS-CREDENTIAL'});
  const revoked=await c.request('revoked','respond',payload);
  assert.equal(revoked.status,401);assert.ok(!(await revoked.text()).includes('NEVER-RETURN'));
  assert.equal((await(await c.request('revoked','status')).json()).connected,false);
  await c.restart();
  assert.equal((await(await c.request('revoked','status')).json()).connected,false,'Rejected credentials stay rejected after connector restart');
  assert.ok((await(await c.request('revoked','login')).json()).pending,'Reconnect must start a new login even with cached account metadata');
  c.fault('revoked',{});await c.approve('revoked','reconnected@example.com');
  assert.equal((await c.request('revoked','respond',payload)).status,200);
  await account('refresh-network',{turnError:'401 Unauthorized',refreshError:'refresh token connection reset'});
  assert.equal((await c.request('refresh-network','respond',payload)).status,503);
  assert.equal((await(await c.request('refresh-network','status')).json()).connected,true);
  await account('permanent',{turnError:'401 Unauthorized',permanent:true});
  assert.equal((await c.request('permanent','respond',payload)).status,401);
  assert.deepEqual(c.stats('permanent'),{refreshes:1,turns:2},'Only one retry, no auth loop');
  assert.equal((await(await c.request('permanent','status')).json()).connected,false);
  assert.equal((await(await c.request('recover','status')).json()).connected,true,'Other accounts remain connected');
  console.log('PASS: transient auth failures, shared refresh, bounded retries, revoked credentials, reconnect and account isolation');
 }finally{await c.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
