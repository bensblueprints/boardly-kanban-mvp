// Administrative helper. Credentials enter only through stdin or cloud.env.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const base='/opt/boardly-clerk',envFile=base+'/cloud.env';
const parse=raw=>Object.fromEntries(raw.split('\n').filter(s=>/^[A-Z_]+=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).trim()];}));
const raw=fs.readFileSync(envFile,'utf8'),env=parse(raw),action=process.argv[2];
const backup=base+'/private-backups/stripe-20260910';
function encode(value,prefix='',body=new URLSearchParams()){for(const[k,v]of Object.entries(value)){if(v==null)continue;const name=prefix?`${prefix}[${k}]`:k;if(typeof v==='object')encode(v,name,body);else body.append(name,String(v));}return body;}
async function stripe(route,data,method='GET'){
 const body=encode(data||{}),r=await fetch('https://api.stripe.com/v1/'+route+(method==='GET'?'?'+body:''),{method,headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY,'Stripe-Version':'2025-12-15.clover',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:method==='POST'?body:undefined,signal:AbortSignal.timeout(20000)});
 const d=await r.json();if(!r.ok){const message=String(d.error?.message||'').split(env.STRIPE_SECRET_KEY).join('[redacted]').replace(/(?:sk|rk|whsec)_[A-Za-z0-9_]+/g,'[redacted]');throw Error(`Stripe ${route.split('/')[0]} returned ${r.status}: ${d.error?.code||d.error?.type||'error'} ${message}`);}return d;
}
(async()=>{
 if(action==='company-entitlements'){
  const desired={STRIPE_SERIAL_PRICE_ID:'Unlimited companies, 5 users and 10 GiB storage. USD 79 per month.',STRIPE_AGENCY_PRICE_ID:'Unlimited companies, 300 users and 1 TiB storage. USD 299 per month.'},results=[];
  for(const [key,description] of Object.entries(desired)){
   const price=await stripe('prices/'+env[key]),product=await stripe('products/'+price.product);
   if(product.metadata?.application!=='boardly')throw Error('Unexpected product scope');
   const updated=product.description===description?product:await stripe('products/'+product.id,{description},'POST');
   if(updated.description!==description)throw Error('Product description was not updated');
   results.push({product:updated.id,name:updated.name,description:updated.description});
  }
  console.log(JSON.stringify({products:results,prices_changed:false,subscriptions_changed:false}));return;
 }
 if(action==='inspect'){
  console.log(JSON.stringify({origin:env.BOARDLY_ORIGIN,ownerOnly:env.BOARDLY_OWNER_ONLY,credentials:Object.fromEntries(Object.entries(env).filter(([k])=>k.startsWith('STRIPE_')||k==='BOARDLY_OPENAI_API_KEY').map(([k,v])=>[k,!!v]))},null,2));return;
 }
 if(action==='stage'){
  const values=JSON.parse(fs.readFileSync(0,'utf8'));
  if(Object.keys(values).some(k=>!['STRIPE_SECRET_KEY','STRIPE_PUBLISHABLE_KEY'].includes(k)))throw Error('Unexpected setting');
  if(!/^sk_live_/.test(values.STRIPE_SECRET_KEY)||!/^pk_live_/.test(values.STRIPE_PUBLISHABLE_KEY))throw Error('Live Stripe credentials required');
  if(env.BOARDLY_ORIGIN!=='https://boardly.onetimesuite.com')throw Error('Wrong deployment');
  fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.chmodSync(backup,0o700);
  for(const file of ['cloud.env','compose.yml'])if(!fs.existsSync(path.join(backup,file))){fs.copyFileSync(path.join(base,file),path.join(backup,file));fs.chmodSync(path.join(backup,file),0o600);}
  const updated=raw.split('\n').filter(s=>!Object.keys(values).some(k=>s.startsWith(k+'='))).join('\n').trimEnd()+'\n'+Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n';
  fs.writeFileSync(envFile+'.stripe-tmp',updated,{mode:0o600});fs.renameSync(envFile+'.stripe-tmp',envFile);fs.chmodSync(envFile,0o600);
  console.log('Live credentials saved in private cloud.env; previous environment and compose backed up.');return;
 }
 if(action==='verify'){
  const account=await stripe('account');
  const details=[];
  for(const [name,key]of [['serial','STRIPE_SERIAL_PRICE_ID'],['agency','STRIPE_AGENCY_PRICE_ID'],['seat','STRIPE_SEAT_PRICE_ID'],['ai','STRIPE_AI_PRICE_ID']]){
   const p=await stripe('prices/'+env[key]);details.push({name,id:p.id,active:p.active,currency:p.currency,amount:p.unit_amount_decimal,recurring:p.recurring});
  }
  const webhook=await stripe('webhook_endpoints/'+env.STRIPE_WEBHOOK_ENDPOINT_ID),portal=await stripe('billing_portal/configurations/'+env.STRIPE_PORTAL_CONFIGURATION_ID);
  console.log(JSON.stringify({account:account.id,charges_enabled:account.charges_enabled,prices:details,webhook:{id:webhook.id,url:webhook.url,status:webhook.status,livemode:webhook.livemode,events:webhook.enabled_events},portal:{id:portal.id,active:portal.active,return_url:portal.default_return_url,features:portal.features}},null,2));return;
 }
 if(action==='probe'){
  const payload=JSON.stringify({id:'evt_boardly_configuration_probe',object:'event',type:'customer.subscription.updated',livemode:true,data:{object:{id:'sub_configuration_probe',object:'subscription',status:'canceled'}}});
  const stamp=String(Math.floor(Date.now()/1000)),signature=crypto.createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(stamp+'.'+payload).digest('hex');
  const results=[];
  for(const [name,sig]of [['valid',signature],['invalid','0'.repeat(64)]]){
   const r=await fetch(env.BOARDLY_ORIGIN+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${stamp},v1=${sig}`},body:payload,signal:AbortSignal.timeout(20000)});
   results.push({name,status:r.status});if(r.status!==(name==='valid'?200:400))throw Error('Public webhook probe failed');
  }
  console.log(JSON.stringify({public_webhook:results,synthetic_probe:true,real_subscription_changes:false}));return;
 }
 if(action==='checkout-probe'){
  // Creates unpaid Checkout sessions, expires them immediately; no card or customer.
  const results=[];
  for(const key of ['STRIPE_SERIAL_PRICE_ID','STRIPE_AGENCY_PRICE_ID','STRIPE_SEAT_PRICE_ID']){
   const session=await stripe('checkout/sessions',{mode:'subscription',payment_method_collection:'always',line_items:[{price:env[key],quantity:1}],success_url:env.BOARDLY_ORIGIN+'/app#/account',cancel_url:env.BOARDLY_ORIGIN+'/app#/account',metadata:{purpose:'boardly_configuration_validation'}},'POST');
   const expired=await stripe('checkout/sessions/'+session.id+'/expire',{},'POST');
   results.push({price:env[key],checkout_created:!!session.url,amount_total:session.amount_total,currency:session.currency,payment_status:expired.payment_status,status:expired.status,subscription_created:!!expired.subscription});
   if(expired.status!=='expired'||expired.subscription)throw Error('Unexpected checkout probe state');
  }
  console.log(JSON.stringify({checkout:results,charges_made:false},null,2));return;
 }
 if(action==='classify-products'){
  const results=[];
  for(const key of ['STRIPE_SERIAL_PRICE_ID','STRIPE_AGENCY_PRICE_ID','STRIPE_SEAT_PRICE_ID','STRIPE_AI_PRICE_ID']){
   const price=await stripe('prices/'+env[key]),product=await stripe('products/'+price.product);
   if(product.metadata?.application!=='boardly')throw Error('Unexpected product scope');
   const taxCode=key==='STRIPE_AI_PRICE_ID'?'txcd_10105002':'txcd_10103001';
   if(product.tax_code&&product.tax_code!==taxCode)throw Error('Existing tax classification differs');
   const descriptions={STRIPE_SERIAL_PRICE_ID:'Unlimited companies, 5 users and 10 GiB storage. USD 79 per month.',STRIPE_AGENCY_PRICE_ID:'Unlimited companies, 300 users and 1 TiB storage. USD 299 per month.',STRIPE_SEAT_PRICE_ID:'One additional licensed user, USD 9 per month after the included account allowance.',STRIPE_AI_PRICE_ID:'Monthly AI usage at 2 times actual standard OpenAI API token cost. Your boredly AI settings control your monthly spending cap.'};
   const updated=await stripe('products/'+product.id,{tax_code:taxCode,description:descriptions[key]},'POST');
   results.push({product:updated.id,name:updated.name,tax_code:updated.tax_code});
  }
  console.log(JSON.stringify({products:results},null,2));return;
 }
 if(action==='delivery-probe'){
  const endpoint=await stripe('webhook_endpoints/'+env.STRIPE_WEBHOOK_ENDPOINT_ID);
  const all=await stripe('webhook_endpoints',{limit:100});
  if(all.has_more||all.data.filter(e=>e.status==='enabled').length!==1)throw Error('Delivery probe requires a single enabled endpoint');
  const price=await stripe('prices/'+env.STRIPE_SERIAL_PRICE_ID);
  const marker=new Date().toISOString();
  try{
   await stripe('webhook_endpoints/'+endpoint.id,{enabled_events:[...endpoint.enabled_events,'product.updated']},'POST');
   await stripe('products/'+price.product,{metadata:{billing_configuration_verified_at:marker}},'POST');
   let event;
   for(let i=0;i<15;i++){
    const events=await stripe('events',{type:'product.updated',limit:20});
    event=events.data.find(e=>e.data.object.id===price.product&&e.data.object.metadata?.billing_configuration_verified_at===marker);
    if(event&&event.pending_webhooks===0)break;
    await new Promise(r=>setTimeout(r,2000));
   }
   if(!event||event.pending_webhooks!==0)throw Error('Stripe event delivery is still pending');
   console.log(JSON.stringify({stripe_event:event.id,type:event.type,livemode:event.livemode,pending_webhooks:event.pending_webhooks,endpoint:endpoint.id,delivered:true,no_payment:true}));
  }finally{
   await stripe('webhook_endpoints/'+endpoint.id,{enabled_events:endpoint.enabled_events},'POST');
   console.log('Original subscription/payment webhook event list restored.');
  }
  return;
 }
 throw Error('Unknown operation');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
