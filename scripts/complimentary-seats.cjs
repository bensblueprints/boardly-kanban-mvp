// Host-admin operation. No Stripe write is made by this script.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Database=require('/app/node_modules/better-sqlite3');
const {createBilling}=require('/app/server/customer-billing');
const {readCloudConfig,workspacePath}=require('/app/server/cloud');
const [action,email,quantityText,grantId]=process.argv.slice(2);
if(!['inspect','grant'].includes(action)||email!=='justin@bluejaypro.com')throw Error('Expected the explicitly requested account');
(async()=>{
 const config=readCloudConfig();
 const response=await fetch('https://api.clerk.com/v1/users?'+new URLSearchParams({'email_address[]':email,limit:'100'}),{headers:{Authorization:'Bearer '+config.secretKey},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Account lookup failed: '+response.status);
 const data=await response.json(),users=(Array.isArray(data)?data:data.data).filter(u=>u.email_addresses.some(a=>a.email_address.toLowerCase()===email));
 if(users.length!==1)throw Error('Expected exactly one matching account, found '+users.length);
 const user=users[0],address=user.email_addresses.find(a=>a.email_address.toLowerCase()===email);
 const workspace=workspacePath(config.dataDir,user.id);
 if(!fs.existsSync(path.join(workspace,'app.db')))throw Error('Matching identity has no Boardly workspace');
 const db=new Database(path.join(config.dataDir,'personal-ai.db'),{readonly:action==='inspect'});
 const mappingBefore=db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').get(user.id)||null;
 const request=async(url,opts)=>{if(opts.method!=='GET')throw Error('Stripe writes are prohibited for complimentary seats');return fetch(url,opts);};
 let before,after;
 if(action==='grant'){
  const quantity=Number(quantityText);
  if(quantity!==2||grantId!=='justin-bluejaypro-two-free-users-20260910')throw Error('Expected the authorized two-seat grant');
  if(address.verification?.status!=='verified')throw Error('Account email must be verified');
  const billing=createBilling({db,config,request});before=await billing.state(user.id);
  const backupRoot=path.join(config.dataDir,'backups','complimentary-seats-20260910');fs.mkdirSync(backupRoot,{recursive:true,mode:0o700});
  const backup=path.join(backupRoot,'personal-ai-before-justin.db');
  if(!fs.existsSync(backup)){await db.backup(backup);fs.chmodSync(backup,0o600);}
  db.transaction(()=>{
   const old=db.prepare('SELECT * FROM billing_complimentary_seats WHERE grant_id=?').get(grantId);
   if(old){if(old.user_id!==user.id||old.quantity!==quantity)throw Error('Grant ID already has different details');return;}
   db.prepare('INSERT INTO billing_complimentary_seats(grant_id,user_id,quantity,reason,created_at) VALUES (?,?,?,?,?)').run(grantId,user.id,quantity,'Account owner requested two additional free users; no charge; no expiration.',Date.now());
  }).immediate();
  after=await billing.state(user.id);
  if(after.complimentary_users<2)throw Error('Complimentary allowance was not applied');
  if(JSON.stringify(before.subscriptions)!==JSON.stringify(after.subscriptions))throw Error('Subscription state changed concurrently; review');
 }else{
  const billing=createBilling({db,config,request});after=await billing.state(user.id);
 }
 const mappingAfter=db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').get(user.id)||null;
 if(JSON.stringify(mappingBefore)!==JSON.stringify(mappingAfter))throw Error('Unexpected billing customer change');
 const members=new Database(path.join(config.dataDir,'memberships.db'),{readonly:true});
 const used=1+members.prepare('SELECT COUNT(*) n FROM account_members WHERE owner_id=?').get(user.id).n;members.close();
 const summarize=s=>({plan:s.plan.slug,base_users:s.plan.users,paid_extra_users:s.paid_extra_users??s.extra_users,complimentary_users:s.complimentary_users||0,total_users:s.plan.users===null?null:s.plan.users+s.extra_users,subscription_count:s.subscriptions?.length||0,stripe_customer:!!s.customer});
 console.log(JSON.stringify({email,user_id:user.id,email_verified:address.verification?.status==='verified',workspace_exists:true,before:before?summarize(before):undefined,after:summarize(after),users_in_use:used,stripe_write_requests:0,grant_id:action==='grant'?grantId:undefined},null,2));
 db.close();
})().catch(e=>{console.error(e.message);process.exitCode=1;});
