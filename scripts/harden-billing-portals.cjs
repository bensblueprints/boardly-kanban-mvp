// Run on the cloud host with its existing private environment. Never prints keys.
const fs=require('node:fs'),envFile='/opt/boardly-clerk/cloud.env';
const raw=fs.readFileSync(envFile,'utf8'),env=Object.fromEntries(raw.split('\n').filter(x=>/^[A-Z_]+=/.test(x)).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1).trim()];}));
function encode(value,prefix='',body=new URLSearchParams()){for(const[k,v]of Object.entries(value)){if(v==null)continue;const name=prefix?`${prefix}[${k}]`:k;if(typeof v==='object')encode(v,name,body);else body.append(name,String(v));}return body;}
async function stripe(route,data,method='GET',id){const body=encode(data||{}),r=await fetch('https://api.stripe.com/v1/'+route+(method==='GET'?'?'+body:''),{method,headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY,'Stripe-Version':'2025-12-15.clover',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(id?{'Idempotency-Key':id}:{})},body:method==='POST'?body:undefined,signal:AbortSignal.timeout(20000)});const d=await r.json();if(!r.ok)throw Error('Stripe request failed: '+r.status+' '+(d.error?.code||d.error?.type));return d;}
(async()=>{
 if(env.BOARDLY_ORIGIN!=='https://boardly.onetimesuite.com')throw Error('Wrong deployment');
 const account=await stripe('account');if(account.id!=='acct_1UDoHGQW5UXyTxU7')throw Error('Wrong Stripe account');
 const prices={};for(const k of ['SERIAL','AGENCY','SEAT'])prices[k]=await stripe('prices/'+env['STRIPE_'+k+'_PRICE_ID']);
 const existing=await stripe('billing_portal/configurations/'+env.STRIPE_PORTAL_CONFIGURATION_ID);
 const backup='/opt/boardly-clerk/private-backups/billing-hardening-20260910';fs.mkdirSync(backup,{recursive:true,mode:0o700});
 for(const [file,value]of [['portal.json',JSON.stringify(existing,null,2)],['cloud.env',raw]])if(!fs.existsSync(backup+'/'+file))fs.writeFileSync(backup+'/'+file,value,{mode:0o600});
 const additions={};
 for(const [family,keys]of [['PLAN',['SERIAL','AGENCY']],['SEAT',['SEAT']]]){
  const key='STRIPE_'+family+'_PORTAL_CONFIGURATION_ID';
  if(env[key]){const p=await stripe('billing_portal/configurations/'+env[key]);if(!p.active)throw Error('Configured portal is inactive');additions[key]=p.id;continue;}
  const portal=await stripe('billing_portal/configurations',{business_profile:{headline:family==='PLAN'?'Change your Boardly plan':'Manage paid extra users'},default_return_url:env.BOARDLY_ORIGIN+'/app#/account',features:{customer_update:{enabled:true,allowed_updates:['email','address','name']},invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end'},subscription_update:{enabled:true,default_allowed_updates:family==='PLAN'?['price']:['quantity'],proration_behavior:'always_invoice',products:keys.map(k=>({product:prices[k].product,prices:[prices[k].id],adjustable_quantity:{enabled:family==='SEAT',...(family==='SEAT'?{minimum:1,maximum:10000}:{})}}))}}},'POST','boardly-portal-hardening-'+family+'-20260910');additions[key]=portal.id;
 }
 // General portal handles card, invoices and cancellation only. Separate update
 // portals prevent switching a $9 seat subscription into a second base plan.
 await stripe('billing_portal/configurations/'+existing.id,{features:{subscription_update:{enabled:false}}},'POST');
 const updated=raw.split('\n').filter(s=>!Object.keys(additions).some(k=>s.startsWith(k+'='))).join('\n').trimEnd()+'\n'+Object.entries(additions).map(([k,v])=>k+'='+v).join('\n')+'\n';
 fs.writeFileSync(envFile+'.portal-tmp',updated,{mode:0o600});fs.renameSync(envFile+'.portal-tmp',envFile);
 console.log(JSON.stringify({account:account.id,charges_enabled:account.charges_enabled,payouts_enabled:account.payouts_enabled,capabilities:account.capabilities,portals:additions,general_update_disabled:true,proration:'always_invoice',cancellation:'at_period_end',customer_subscriptions_modified:false}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
