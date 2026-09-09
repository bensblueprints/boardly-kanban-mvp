const crypto=require('node:crypto');
const express=require('express');
const {PLANS,OWNER}=require('./account-plans');
const fail=(status,message)=>Object.assign(Error(message),{status});
function createBilling({db,config,request=fetch}){
 const cfg=config.billing||{};
 db.exec('CREATE TABLE IF NOT EXISTS billing_customers(user_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL UNIQUE);');
 const prices={serial_entrepreneur:cfg.serialPrice,agency:cfg.agencyPrice,extra_users:cfg.seatPrice,ai:cfg.aiPrice};
 const ready=()=>!!(cfg.secretKey&&cfg.webhookSecret&&Object.values(prices).every(Boolean));
 function encode(value,prefix='',body=new URLSearchParams()){
  for(const [key,v] of Object.entries(value)){if(v==null)continue;const name=prefix?`${prefix}[${key}]`:key;if(typeof v==='object')encode(v,name,body);else body.append(name,String(v));}return body;
 }
 async function stripe(route,data,method='POST',idempotency){
  if(!cfg.secretKey)throw fail(503,'Card billing is awaiting the account owner’s Stripe setup');
  const form=encode(data||{}),url='https://api.stripe.com/v1/'+route+(method==='GET'?'?'+form:'');
  const response=await request(url,{method,headers:{Authorization:`Bearer ${cfg.secretKey}`,'Stripe-Version':'2025-12-15.clover',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idempotency?{'Idempotency-Key':idempotency}:{})},body:method==='POST'?form.toString():undefined,signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw fail(503,'The payment provider could not complete this request. Please try again or contact the account owner.');return result;
 }
 async function customer(userId){
  const old=db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').get(userId);if(old)return old.customer_id;
  const result=await stripe('customers',{metadata:{boardly_user:userId}},'POST','boardly-customer-'+userId);
  db.prepare('INSERT OR IGNORE INTO billing_customers VALUES (?,?)').run(userId,result.id);return db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').get(userId).customer_id;
 }
 async function subscriptions(userId){
  const cid=db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').get(userId)?.customer_id;
  if(!cid)return{customer:null,items:[]};
  const result=await stripe('subscriptions',{customer:cid,status:'all',limit:100},'GET');
  if(result.has_more)throw fail(503,'This account’s subscriptions need billing review');
  return{customer:cid,items:result.data};
 }
 const entitled=s=>s.status==='active'&&(!s.current_period_end||s.current_period_end*1000>Date.now());
 async function state(userId){
  if(!ready())return{ready:false,plan:userId===config.ownerId?OWNER:PLANS.basic,extra_users:0,ai:false};
  const all=await subscriptions(userId),active=all.items.filter(entitled);
  const has=price=>active.some(s=>s.items.data.some(i=>i.price.id===price));
  const plan=userId===config.ownerId?OWNER:has(prices.agency)?PLANS.agency:has(prices.serial_entrepreneur)?PLANS.serial_entrepreneur:PLANS.basic;
  const extra=active.flatMap(s=>s.items.data).filter(i=>i.price.id===prices.extra_users).reduce((n,i)=>n+i.quantity,0);
  return{ready:true,plan,extra_users:extra,ai:has(prices.ai),customer:all.customer,subscriptions:all.items};
 }
 async function checkout(userId,kind,quantity=1){
  if(!ready())throw fail(503,'Card billing is awaiting the account owner’s Stripe setup');
  if(!prices[kind])throw fail(400,'Choose a valid plan or AI billing');
  if(kind==='extra_users'&&(!Number.isSafeInteger(quantity)||quantity<1||quantity>10000))throw fail(400,'Choose between 1 and 10,000 additional users');
  if(kind!=='extra_users')quantity=1;
  const cid=await customer(userId),s=await subscriptions(userId);
  const relevant=kind==='ai'?[prices.ai]:kind==='extra_users'?[prices.extra_users]:[prices.serial_entrepreneur,prices.agency];
  const existing=s.items.find(x=>!['canceled','incomplete_expired'].includes(x.status)&&x.items.data.some(i=>relevant.includes(i.price.id)));
  if(existing){
   if(kind==='ai')return stripe('billing_portal/sessions',{customer:cid,configuration:cfg.portalConfiguration,return_url:config.origin+'/#/account'});
   const item=existing.items.data.find(i=>relevant.includes(i.price.id));
   return stripe('billing_portal/sessions',{customer:cid,configuration:cfg.portalConfiguration,return_url:config.origin+'/#/account',flow_data:{type:'subscription_update_confirm',subscription_update_confirm:{subscription:existing.id,items:[{id:item.id,price:prices[kind],quantity}]},after_completion:{type:'redirect',redirect:{return_url:config.origin+'/#/account'}}}});
  }
  return stripe('checkout/sessions',{customer:cid,mode:'subscription',payment_method_types:['card'],payment_method_collection:'always',line_items:[{price:prices[kind],...(kind==='ai'?{}:{quantity})}],subscription_data:{metadata:{boardly_user:userId,kind}},success_url:config.origin+'/#/account',cancel_url:config.origin+'/#/account',client_reference_id:userId,custom_text:{submit:{message:kind==='ai'?'AI is billed monthly at 2× OpenAI’s standard API usage cost. Your personal AI settings control your monthly spending cap.':kind==='extra_users'?'Additional users cost $9 each per month after the included allowance.':'Monthly boredly account subscription.'}}},'POST','boardly-checkout-'+userId+'-'+kind+'-'+quantity+'-'+Math.floor(Date.now()/1800000));
 }
 async function report(row){
  const cid=db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').get(row.user_id)?.customer_id;
  if(!cid||!ready())throw Error('Billing setup unavailable');
  await stripe('billing/meter_events',{event_name:cfg.meterEvent||'boardly_ai_nano_usd',identifier:row.response_id,payload:{stripe_customer_id:cid,value:String(row.billable_nano)},timestamp:Math.floor(row.created_at/1000)},'POST','boardly-usage-'+row.response_id);
 }
 const webhook=express.Router();webhook.post('/api/billing/webhook',express.raw({type:'application/json',limit:'1mb'}),(req,res)=>{
  const parts=String(req.headers['stripe-signature']||'').split(',').map(v=>v.split('=')),stamp=parts.find(p=>p[0]==='t')?.[1];
  if(!cfg.webhookSecret||!stamp||Math.abs(Date.now()/1000-Number(stamp))>300||!Buffer.isBuffer(req.body))return res.sendStatus(400);
  const expected=crypto.createHmac('sha256',cfg.webhookSecret).update(stamp+'.').update(req.body).digest('hex');
  const valid=parts.some(([k,v])=>k==='v1'&&/^[a-f0-9]{64}$/.test(v)&&crypto.timingSafeEqual(Buffer.from(v),Buffer.from(expected)));
  if(!valid)return res.sendStatus(400);
  // Entitlements are read from Stripe on each billing-sensitive request. Event
  // ordering, forged checkout redirects and replay cannot grant a subscription.
  res.json({received:true});
 });
 return{ready,state,checkout,report,webhook,portal:async userId=>stripe('billing_portal/sessions',{customer:await customer(userId),configuration:cfg.portalConfiguration,return_url:config.origin+'/#/account'})};
}
module.exports={createBilling};
