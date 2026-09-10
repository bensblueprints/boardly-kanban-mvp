const crypto=require('node:crypto');
const path=require('node:path');
const Database=require('better-sqlite3');
const express=require('express');
const {RATES,cost,VERSION}=require('./ai-rates');
const fail=(status,message)=>Object.assign(Error(message),{status});
function createPersonalAI({config,key,request=fetch}){
 const db=new Database(path.join(config.dataDir,'personal-ai.db'));require('node:fs').chmodSync(path.join(config.dataDir,'personal-ai.db'),0o600);db.pragma('journal_mode = WAL');
 db.exec(`CREATE TABLE IF NOT EXISTS ai_accounts(user_id TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'none',encrypted_key TEXT,model TEXT NOT NULL DEFAULT 'gpt-6-astra',monthly_cap_nano INTEGER NOT NULL DEFAULT 20000000000);
 CREATE TABLE IF NOT EXISTS ai_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,job_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,hold_nano INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_usage(response_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,job_id TEXT NOT NULL,mode TEXT NOT NULL,model TEXT NOT NULL,rate_version TEXT NOT NULL,usage_json TEXT NOT NULL,provider_nano INTEGER NOT NULL,billable_nano INTEGER NOT NULL,created_at INTEGER NOT NULL,reported_at INTEGER);`);
 for(const [name,type] of [['response_id','TEXT'],['usage_json','TEXT']])if(!db.prepare('PRAGMA table_info(ai_requests)').all().some(c=>c.name===name))db.exec(`ALTER TABLE ai_requests ADD COLUMN ${name} ${type}`);
 // A server interruption never retries an uncertain, potentially billable call.
 db.prepare("UPDATE ai_requests SET status='review' WHERE status='pending'").run();
 const billing=require('./customer-billing').createBilling({db,config,request});
 const account=user=>db.prepare('SELECT * FROM ai_accounts WHERE user_id=?').get(user)||{user_id:user,mode:'none',model:'gpt-6-astra',monthly_cap_nano:20e9};
 function setMode(user,mode){if(!['none','chatgpt'].includes(mode))throw Error('Invalid connection mode');const old=account(user);db.prepare('INSERT INTO ai_accounts VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode').run(user,mode,old.encrypted_key||null,old.model,old.monthly_cap_nano);}
 function seal(user,value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('personal-ai:'+user));return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]).toString('base64');}
 function unseal(user,value){const b=Buffer.from(value,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from('personal-ai:'+user));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString();}
 const month=()=>Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),1);
 function summary(user){
  const a=account(user),usage=db.prepare('SELECT COALESCE(SUM(provider_nano),0) provider_nano,COALESCE(SUM(billable_nano),0) billable_nano FROM ai_usage WHERE user_id=? AND created_at>=?').get(user,month());
  return{mode:a.mode,model:a.model,has_key:!!a.encrypted_key,monthly_cap:a.monthly_cap_nano/1e9,usage:{provider_cost:usage.provider_nano/1e9,boardly_charge:usage.billable_nano/1e9},billing_ready:billing.ready()&&!!config.openaiApiKey,rate_version:VERSION,models:Object.entries(RATES).map(([id,r])=>({id,input:r.input,output:r.output,cached:r.cached,cache_write:r.write})),review:db.prepare("SELECT COUNT(*) n FROM ai_requests WHERE user_id=? AND status='review'").get(user).n,history:db.prepare('SELECT model,mode,provider_nano/1000000000.0 provider_cost,billable_nano/1000000000.0 boardly_charge,created_at FROM ai_usage WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(user)};
 }
 async function authorize(user){
  const a=account(user);
  if(a.mode==='key'&&a.encrypted_key)return{...a,key:unseal(user,a.encrypted_key)};
  if(a.mode==='card'){
   if(!config.openaiApiKey||!billing.ready())throw fail(503,'Card-funded AI is awaiting Boardly’s payment and OpenAI setup');
   if(!(await billing.state(user)).ai)throw fail(402,'Attach a billing card and activate AI usage billing in Account & AI');
   if(summary(user).review)throw fail(409,'An interrupted AI request needs billing review before another charged run');
   return{...a,key:config.openaiApiKey};
  }
  throw fail(402,'Connect your ChatGPT account in Account & AI. You can also choose an OpenAI API key or card billing.');
 }
 function reserve(a,jobId,maximum){return db.transaction(()=>{
  if(db.prepare("SELECT id FROM ai_requests WHERE user_id=? AND status='pending'").get(a.user_id))throw fail(409,'Another AI request is running on your account');
  if(a.mode==='card'){
   const used=db.prepare('SELECT COALESCE(SUM(billable_nano),0) n FROM ai_usage WHERE user_id=? AND created_at>=?').get(a.user_id,month()).n;
   const held=db.prepare("SELECT COALESCE(SUM(hold_nano),0) n FROM ai_requests WHERE user_id=? AND status IN ('pending','review')").get(a.user_id).n;
   if(used+held+maximum>a.monthly_cap_nano)throw fail(402,'Your monthly AI spending cap has insufficient room for this response. Adjust it in Account & AI.');
  }
  const id=crypto.randomUUID();db.prepare("INSERT INTO ai_requests(id,user_id,job_id,mode,status,hold_nano,created_at) VALUES (?,?,?,?,'pending',?,?)").run(id,a.user_id,jobId,a.mode,maximum,Date.now());return id;
 }).immediate();}
 async function respond(a,jobId,payload){
  // The UTF-8 request byte count is a conservative token upper bound for these
  // text-only inputs. Reserve cache-write and output maximums before the call.
  const bytes=Buffer.byteLength(JSON.stringify(payload));if(bytes>90000)throw fail(400,'This conversation is too large. Start a new conversation.');
  const rates=RATES[a.model],maximum=Math.ceil(((bytes+4096)*rates.write+payload.max_output_tokens*rates.output)*2000);
  const id=reserve(a,jobId,maximum);let knownFailure=false;
  try{
   const response=await request('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${a.key}`,'Content-Type':'application/json','X-Client-Request-Id':id},body:JSON.stringify(payload),signal:AbortSignal.timeout(110000)});
   if(!response.ok){knownFailure=response.status>=400&&response.status<500;throw fail(response.status===401?401:502,response.status===401?'Your OpenAI API key was rejected. Replace it in Account & AI.':'OpenAI could not complete the request. Check your API account and try again.');}
   const result=await response.json();
   db.prepare('UPDATE ai_requests SET response_id=?,usage_json=? WHERE id=?').run(typeof result.id==='string'?result.id:null,JSON.stringify({model:result.model,service_tier:result.service_tier,usage:result.usage}),id);
   const priced=cost(result);
   if(typeof result.id!=='string'||!result.id.startsWith('resp_'))throw Error('Usage needs pricing review');
   db.transaction(()=>{
    db.prepare('INSERT INTO ai_usage VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(result.id,a.user_id,jobId,a.mode,result.model,priced.version,JSON.stringify(result.usage),priced.nano,a.mode==='card'?priced.nano*2:0,Date.now());
    db.prepare("UPDATE ai_requests SET status='complete',hold_nano=0 WHERE id=?").run(id);
   })();
   return result;
  }catch(e){db.prepare('UPDATE ai_requests SET status=?,hold_nano=CASE WHEN ? THEN 0 ELSE hold_nano END WHERE id=? AND status=\'pending\'').run(knownFailure?'failed':'review',knownFailure?1:0,id);throw e.status?e:fail(502,'The AI request was interrupted or its usage needs review. It has not been automatically retried.');}
 }
 let flushing=false;
 async function flush(){if(flushing||!billing.ready())return;flushing=true;try{for(const row of db.prepare("SELECT * FROM ai_usage WHERE mode='card' AND reported_at IS NULL ORDER BY created_at LIMIT 100").all()){await billing.report(row);db.prepare('UPDATE ai_usage SET reported_at=? WHERE response_id=?').run(Date.now(),row.response_id);}}catch{/* durable outbox is retried; never discard a charge */}finally{flushing=false;}}
 const timer=setInterval(flush,30000);timer.unref();
 const router=express.Router();router.use('/api/ai',express.json({limit:'12kb'}));
 router.get('/api/ai/settings',(req,res)=>res.json(summary(req.cloudUserId)));
 router.put('/api/ai/settings',async(req,res,next)=>{
  try{
   const user=req.cloudUserId,old=account(user),{mode,model,api_key,monthly_cap}=req.body||{};
   if(!['none','key','card','chatgpt'].includes(mode)||!RATES[model])throw fail(400,'Choose an AI connection and model');
   if(mode==='chatgpt'&&old.mode!=='chatgpt')throw fail(400,'Connect and activate ChatGPT first');
   if(typeof monthly_cap!=='number'||monthly_cap<1||monthly_cap>10000||!Number.isSafeInteger(Math.round(monthly_cap*1e9)))throw fail(400,'Enter a monthly AI cap between $1 and $10,000');
   let encrypted=old.encrypted_key||null;
   if(api_key){
    if(typeof api_key!=='string'||!/^sk-[A-Za-z0-9_-]{20,500}$/.test(api_key))throw fail(400,'Enter a valid OpenAI API key');
    const check=await request('https://api.openai.com/v1/models/'+model,{headers:{Authorization:`Bearer ${api_key}`},signal:AbortSignal.timeout(15000)});
    if(!check.ok)throw fail(400,'This key could not access the selected OpenAI model. Check its permissions.');
    encrypted=seal(user,api_key);
   }
   if(mode==='key'&&!encrypted)throw fail(400,'Enter your OpenAI API key');
   if(mode==='card'&&(!billing.ready()||!config.openaiApiKey))throw fail(503,'Card-funded AI is awaiting Boardly’s payment and OpenAI setup');
   if(mode==='none')encrypted=null;
   db.prepare('INSERT INTO ai_accounts VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,encrypted_key=excluded.encrypted_key,model=excluded.model,monthly_cap_nano=excluded.monthly_cap_nano').run(user,mode,encrypted,model,Math.round(monthly_cap*1e9));
   res.json(summary(user));
  }catch(e){next(e.status?e:fail(503,'Could not verify the OpenAI key. Please try again.'));}
 });
 router.post('/api/ai/checkout',async(req,res,next)=>{try{if(!config.openaiApiKey)throw fail(503,'Card-funded AI is awaiting Boardly’s OpenAI setup');if(req.body?.consent!==true)throw fail(400,'Confirm AI usage billing at 2× OpenAI rates');res.json(await billing.checkout(req.cloudUserId,'ai'));}catch(e){next(e);}});
 return{db,billing,router,summary,account,setMode,authorize,respond,flush,close(){clearInterval(timer);db.close();}};
}
module.exports={createPersonalAI};
