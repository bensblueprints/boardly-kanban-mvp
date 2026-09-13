const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Database=require('better-sqlite3');
const express=require('express');
const {createBilling}=require('../server/customer-billing');

(async()=>{
 const db=new Database(':memory:');
 const cfg={secretKey:'sk_test_fixture',webhookSecret:'whsec_fixture',serialPrice:'price_serial',agencyPrice:'price_agency',seatPrice:'price_seat',aiPrice:'price_ai',portalConfiguration:'bpc_fixture'};
 const config={ownerId:'user_owner',origin:'https://boardly.example.com',billing:cfg};
 const calls=[];let subscriptions=[];
 const request=async(url,options)=>{
  const u=new URL(url),body=new URLSearchParams(options.body||u.search);
  calls.push({path:u.pathname,body});
  if(u.pathname.endsWith('/customers'))return Response.json({id:'cus_fixture'});
  if(u.pathname.endsWith('/subscriptions'))return Response.json({data:subscriptions,has_more:false});
  return Response.json({id:'cs_fixture',url:'https://checkout.stripe.com/example'});
 };
 const billing=createBilling({db,config,request});
 const sub=(price,status='active',quantity=1,extra={})=>({id:'sub_fixture',status,items:{data:[{id:'si_fixture',price:{id:price},quantity}]},...extra});
 const state=()=>billing.state('user_customer');
 assert.equal((await state()).plan.slug,'basic');
 await billing.checkout('user_customer','serial_entrepreneur');
 let call=calls.at(-1);assert.equal(call.path,'/v1/checkout/sessions');
 assert.equal(call.body.get('success_url'),config.origin+'/app#/account');
 assert.equal(call.body.get('cancel_url'),config.origin+'/app#/account');
 assert.equal(call.body.get('client_reference_id'),'user_customer');
 assert.equal(call.body.has('payment_method_types[0]'),false,'Managed Payments chooses payment methods');
 assert.equal(call.body.has('custom_text[submit][message]'),false,'Managed Payments controls checkout text');
 subscriptions=[sub(cfg.serialPrice)];assert.equal((await state()).plan.slug,'serial_entrepreneur');assert.equal((await state()).plan.companies,null);assert.equal((await state()).plan.users,5);
 await billing.checkout('user_customer','agency');call=calls.at(-1);
 assert.equal(call.path,'/v1/billing_portal/sessions');
 assert.equal(call.body.get('flow_data[subscription_update_confirm][subscription]'),'sub_fixture');
 assert.equal(call.body.get('flow_data[subscription_update_confirm][items][0][price]'),cfg.agencyPrice);
 assert.equal(call.body.get('flow_data[after_completion][redirect][return_url]'),config.origin+'/app#/account');
 subscriptions=[sub(cfg.agencyPrice)];assert.equal((await state()).plan.slug,'agency');assert.equal((await state()).plan.companies,null);assert.equal((await state()).plan.users,300);
 await billing.checkout('user_customer','serial_entrepreneur');
 assert.equal(calls.at(-1).body.get('flow_data[subscription_update_confirm][items][0][price]'),cfg.serialPrice);
 subscriptions=[sub(cfg.serialPrice)];assert.equal((await state()).plan.slug,'serial_entrepreneur');
 subscriptions=[sub(cfg.serialPrice,'active',1,{cancel_at_period_end:true})];assert.equal((await state()).plan.slug,'serial_entrepreneur');
 for(const status of ['canceled','past_due','unpaid','incomplete','incomplete_expired','paused']){
  subscriptions=[sub(cfg.agencyPrice,status)];assert.equal((await state()).plan.slug,'basic',status);
 }
 subscriptions=[sub(cfg.serialPrice),sub(cfg.seatPrice,'active',3)];assert.equal((await state()).extra_users,3);
 subscriptions=[sub(cfg.serialPrice),sub(cfg.seatPrice,'canceled',3)];assert.equal((await state()).extra_users,0);
 assert.equal((await billing.state('user_other')).plan.slug,'basic');
 assert.equal((await billing.state(config.ownerId)).plan.slug,'owner');
 await billing.portal('user_customer');assert.equal(calls.at(-1).body.get('return_url'),config.origin+'/app#/account');
 await assert.rejects(()=>billing.checkout('user_customer','extra_users',-1),{status:400});
 const app=express();app.use(billing.webhook);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/billing/webhook`;
  const raw=JSON.stringify({id:'evt_fixture',type:'customer.subscription.updated',data:{object:sub(cfg.agencyPrice)}});
  const send=(stamp,valid=true)=>{const signature=crypto.createHmac('sha256',cfg.webhookSecret).update(stamp+'.'+raw).digest('hex');return fetch(url,{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${stamp},v1=${valid?signature:'0'.repeat(64)}`},body:raw});};
  const now=String(Math.floor(Date.now()/1000));
  assert.equal((await send(now)).status,200);assert.equal((await send(now)).status,200);
  assert.equal((await send(now,false)).status,400);
  assert.equal((await send(String(Number(now)-301))).status,400);
  assert.equal((await send('NaN')).status,400);
  subscriptions=[];assert.equal((await state()).plan.slug,'basic','Signed stale events cannot grant access');
 }finally{await new Promise(r=>server.close(r));db.close();}
 console.log('PASS: checkout/portal return to app, upgrades, downgrades, paid-period cancellation, payment failures, seats, user isolation, signed webhook replay and invalid-signature rejection. No real charges.');
})().catch(e=>{console.error(e);process.exitCode=1;});
