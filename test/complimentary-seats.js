const assert=require('node:assert/strict');
const path=require('node:path');
const Database=require('better-sqlite3');
const {fixture}=require('./member-fixture');
const {createBilling}=require('../server/customer-billing');

(async()=>{
 let calls=0;
 const billing={secretKey:'sk_test_fixture',webhookSecret:'whsec_fixture',serialPrice:'price_serial',agencyPrice:'price_agency',seatPrice:'price_seat',aiPrice:'price_ai'};
 const providerRequest=async()=>{calls++;throw Error('A free seat must not contact Stripe');};
 const f=await fixture({publicAccess:true,billing,providerRequest});
 try{
  const user='user_complimentary',p=await f.project('Free account','Free project',user);
  assert.equal((await f.api('/api/account/plan',{user})).user_limit,1);
  const db=new Database(path.join(f.root,'personal-ai.db'));
  db.prepare('INSERT INTO billing_complimentary_seats VALUES (?,?,?,?,?)').run('grant_fixture',user,2,'Two complimentary users',Date.now());
  assert.throws(()=>db.prepare('INSERT INTO billing_complimentary_seats VALUES (?,?,?,?,?)').run('grant_fixture',user,2,'Duplicate',Date.now()),/UNIQUE/);
  let plan=await f.api('/api/account/plan',{user});
  assert.equal(plan.plan.slug,'basic');assert.equal(plan.plan.monthly_price,0);assert.equal(plan.user_limit,3);assert.equal(plan.plan.complimentary_users,2);
  for(const email of ['first@fixture.example','second@fixture.example'])await f.api(`/api/projects/${p.project.id}/members`,{user,method:'POST',body:{email,role:'editor'}});
  assert.equal((await f.api('/api/account/plan',{user})).usage.users,3);
  assert.equal((await f.request(`/api/projects/${p.project.id}/members`,{user,method:'POST',body:{email:'third@fixture.example',role:'editor'}})).status,409);
  const member=f.users.find(u=>u.emailAddresses.some(a=>a.emailAddress==='first@fixture.example')).id;
  assert.equal((await f.api('/api/account/plan',{user:member,workspace:user})).user_limit,3);
  assert.equal((await f.api('/api/billing/status',{user})).complimentary_users,2);
  assert.equal((await f.api('/api/billing/status',{user:member,workspace:user})).complimentary_users,0,'Personal billing stays separate from the selected sponsoring workspace');
  assert.equal((await f.api('/api/account/plan',{user:'user_unrelated'})).user_limit,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_customers').get().n,0);assert.equal(calls,0);
  const reopened=createBilling({db,config:f.config,request:providerRequest});
  assert.equal((await reopened.state(user)).extra_users,2,'Grant persists across billing service recreation');
  assert.equal((await reopened.state(user)).paid_extra_users,0);
  db.prepare('INSERT INTO billing_customers VALUES (?,?)').run(user,'cus_fixture');
  let active=true;
  const paid=createBilling({db,config:f.config,request:async(url,opts)=>{
   assert.equal(opts.method,'GET');return Response.json({has_more:false,data:active?[{id:'sub_fixture',status:'active',items:{data:[{price:{id:billing.seatPrice},quantity:4}]}}]:[]});
  }});
  assert.equal((await paid.state(user)).extra_users,6);assert.equal((await paid.state(user)).paid_extra_users,4);
  active=false;assert.equal((await paid.state(user)).extra_users,2,'Complimentary users survive paid-seat cancellation');
  db.close();
  console.log('PASS: two free seats permit two members, block a third, persist, apply to shared workspaces, isolate other accounts, combine with paid seats, and make no Stripe writes.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
