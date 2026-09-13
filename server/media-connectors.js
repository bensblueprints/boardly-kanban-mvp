// Media credentials belong to one customer workspace. Agents receive approved
// model metadata and job results only; HTTP destinations are fixed by provider.
const crypto=require('node:crypto'),express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
const providers={fal:{label:'fal',origin:'https://queue.fal.run',model:'fal-ai/flux/schnell'},higgsfield:{label:'Higgsfield',origin:'https://api.higgsfield.ai',model:'higgsfield-ai/soul/v2/standard'}};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(v);
function createMediaConnectors({db,key,namespace,request=fetch}){
 db.exec(`CREATE TABLE IF NOT EXISTS media_connections(provider TEXT PRIMARY KEY,encrypted TEXT NOT NULL,model TEXT NOT NULL,defaults_json TEXT NOT NULL,daily_limit INTEGER NOT NULL,revision TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS media_grants(id INTEGER PRIMARY KEY,company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,provider TEXT NOT NULL,CHECK((company_id IS NULL)!=(board_id IS NULL)),UNIQUE(company_id,provider),UNIQUE(board_id,provider));
 CREATE TABLE IF NOT EXISTS media_jobs(id TEXT PRIMARY KEY,board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,provider TEXT NOT NULL,actor TEXT NOT NULL,model TEXT NOT NULL,prompt TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,status TEXT NOT NULL,remote_id TEXT,status_url TEXT,response_url TEXT,cancel_url TEXT,outputs_json TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
 db.prepare("UPDATE media_jobs SET status='uncertain' WHERE status='submitting'").run();
 const conn=p=>db.prepare('SELECT * FROM media_connections WHERE provider=?').get(p);
 const seal=(p,value)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify(['media',namespace,p])));return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]).toString('base64');};
 const unseal=r=>{const b=Buffer.from(r.encrypted,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(JSON.stringify(['media',namespace,r.provider])));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString();};
 function summary(p){if(!providers[p])throw fail(404,'Media provider not found.');const c=conn(p);return {provider:p,label:providers[p].label,saved:!!c,verified:!!c?.verified,model:c?.model||providers[p].model,defaults:c?JSON.parse(c.defaults_json):{},daily_limit:c?.daily_limit||10};}
 function save(p,data){
  summary(p);const old=conn(p),token=data.token||(old?unseal(old):'');
  if(typeof token!=='string'||!token||token.length>4000||/[\x00-\x20]/.test(token)||p==='higgsfield'&&!/^[^:]+:[^:]+$/.test(token))throw fail(400,p==='higgsfield'?'Enter your Higgsfield API key ID and secret separated by a colon.':'Enter your fal API key.');
  // A model path cannot address account, request, credential or admin APIs.
  if(typeof data.model!=='string'||data.model.length>200||!/^[-a-zA-Z0-9_.]+(?:\/[-a-zA-Z0-9_.]+)*$/.test(data.model)||data.model.split('/').some(s=>s==='.'||s==='..'||['requests','accounts','auth','admin'].includes(s))||p==='fal'&&!data.model.startsWith('fal-ai/'))throw fail(400,'Enter the model endpoint ID from the provider model page.');
  if(!data.defaults||Array.isArray(data.defaults)||typeof data.defaults!=='object'||JSON.stringify(data.defaults).length>8000||Object.keys(data.defaults).some(k=>/prompt|key|token|secret|authorization|webhook/i.test(k)))throw fail(400,'Use a JSON object of model options without prompts, credentials or webhooks.');
  if(!Number.isInteger(data.daily_limit)||data.daily_limit<1||data.daily_limit>1000)throw fail(400,'Choose a daily limit from 1 to 1,000 generation requests.');
  const verified=old&&!data.token?old.verified:0;
  db.prepare('INSERT INTO media_connections VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET encrypted=excluded.encrypted,model=excluded.model,defaults_json=excluded.defaults_json,daily_limit=excluded.daily_limit,revision=excluded.revision,verified=excluded.verified').run(p,seal(p,token),data.model,JSON.stringify(data.defaults),data.daily_limit,crypto.randomUUID(),verified);return summary(p);
 }
 function scope(kind,id){if(!Number.isSafeInteger(id)||!db.prepare(`SELECT id FROM ${kind==='company'?'companies':'boards'} WHERE id=?`).get(id))throw fail(404,'Company or project not found.');return kind==='project'?require('./hierarchy').createHierarchy(db).scope(id)?.company_id:null;}
 function grants(kind,id,p){const company=scope(kind,id);const own=!!db.prepare(`SELECT id FROM media_grants WHERE ${kind==='company'?'company_id':'board_id'}=? AND provider=?`).get(id,p),inherited=!!(company&&db.prepare('SELECT id FROM media_grants WHERE company_id=? AND provider=?').get(company,p));return {...summary(p),enabled:own,inherited,allowed:own||inherited};}
 function assign(kind,id,p,enabled){grants(kind,id,p);if(typeof enabled!=='boolean')throw fail(400,'Choose whether to allow generation.');const field=kind==='company'?'company_id':'board_id';db.transaction(()=>{db.prepare(`DELETE FROM media_grants WHERE ${field}=? AND provider=?`).run(id,p);if(enabled)db.prepare(`INSERT INTO media_grants(${field},provider) VALUES(?,?)`).run(id,p);})();return grants(kind,id,p);}
 const forAgent=id=>Object.keys(providers).map(p=>grants('project',id,p)).filter(p=>p.saved&&p.allowed).map(({provider,label,model,daily_limit})=>({provider,label,model,daily_limit}));
 function operationURL(p,id,value){if(typeof value!=='string')throw fail(502,'The media provider returned an invalid job URL.');let u;try{u=new URL(value);}catch{throw fail(502,'Invalid provider job URL.');}if(u.origin!==providers[p].origin||u.username||u.password||u.search||u.hash||!u.pathname.includes('/requests/'+id)||!/^[\w/.-]+$/.test(u.pathname)||u.pathname.split('/').includes('..'))throw fail(502,'The media provider returned an unexpected job URL.');return u.href;}
 async function call(c,url,method='GET',body){
  let r;try{r=await request(url,{method,headers:{Authorization:'Key '+unseal(c),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw fail(502,'Provider connection interrupted. Check the saved job before submitting again.');}
  if(!r.ok)throw fail(r.status===401?401:r.status===429?429:r.status===400?400:502,r.status===401?'The media API key was rejected. Replace it in account settings.':r.status===429?'The provider limit was reached. Check its dashboard.':r.status===400?'The provider rejected the options or this operation. Check its model page and job status.':'The media provider could not complete this request.');
  let n=0,parts=[];for await(const b of r.body||[]){n+=b.length;if(n>1000000)throw fail(502,'Media result exceeds the supported size.');parts.push(b);}if(!n)return{};try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw fail(502,'The media provider returned invalid JSON.');}
 }
 const job=id=>db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id);
 const publicJob=j=>({id:j.id,provider:j.provider,model:j.model,prompt:j.prompt,status:j.status,request_id:j.remote_id,outputs:JSON.parse(j.outputs_json),created_at:j.created_at,updated_at:j.updated_at});
 function check(projectId,p,c,valid){valid();const g=grants('project',projectId,p);if(!c||!g.allowed||!g.saved||conn(p)?.revision!==c.revision)throw fail(403,'Media generation is disabled or this connection changed.');}
 async function generate(projectId,actor,data,valid){
  const {provider:p,prompt,request_key:requestKey}=data;summary(p);const c=conn(p);check(projectId,p,c,valid);
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>8000||!uuid(requestKey))throw fail(400,'Enter a prompt and a stable UUID request key.');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([projectId,p,prompt,c.model,c.defaults_json])).digest('hex');
  let repeat;
  const id=db.transaction(()=>{repeat=db.prepare('SELECT * FROM media_jobs WHERE request_key=?').get(requestKey);if(repeat){if(repeat.fingerprint!==fingerprint||repeat.board_id!==projectId)throw fail(409,'This request key belongs to different generation input.');return repeat.id;}
   const day=new Date();day.setUTCHours(0,0,0,0);if(db.prepare('SELECT COUNT(*) n FROM media_jobs WHERE provider=? AND created_at>=?').get(p,+day).n>=c.daily_limit)throw fail(429,'This account’s daily generation limit was reached. It resets at midnight UTC.');
   const id=crypto.randomUUID();db.prepare("INSERT INTO media_jobs(id,board_id,provider,actor,model,prompt,request_key,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'submitting',?,?)").run(id,projectId,p,actor,c.model,prompt,requestKey,fingerprint,Date.now(),Date.now());return id;
  }).immediate();if(repeat)return publicJob(repeat);
  try{
   const r=await call(c,providers[p].origin+'/'+c.model,'POST',{...JSON.parse(c.defaults_json),prompt});
   if(!uuid(r.request_id))throw fail(502,'The provider returned no valid request ID. Review its dashboard before retrying.');
   const status=operationURL(p,r.request_id,r.status_url),cancel=operationURL(p,r.request_id,r.cancel_url),response=p==='fal'?operationURL(p,r.request_id,r.response_url):null;
   // Persist acknowledgement before checking revocation: a submitted external
   // job can still incur cost and must remain identifiable in the owner UI.
   db.prepare("UPDATE media_jobs SET status='queued',remote_id=?,status_url=?,response_url=?,cancel_url=?,updated_at=? WHERE id=?").run(r.request_id,status,response,cancel,Date.now(),id);
   db.prepare('UPDATE media_connections SET verified=1 WHERE provider=? AND revision=?').run(p,c.revision);check(projectId,p,c,valid);return publicJob(job(id));
  }catch(e){db.prepare("UPDATE media_jobs SET status='uncertain',updated_at=? WHERE id=? AND status='submitting'").run(Date.now(),id);throw e;}
 }
 function outputs(value){const urls=[];for(const item of [...(Array.isArray(value.images)?value.images:[]),value.video,value.audio,...(Array.isArray(value.audios)?value.audios:[])]){try{const u=new URL(item?.url);if(u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<4000)urls.push(u.href);}catch{}}return [...new Set(urls)].slice(0,20);}
 async function refresh(projectId,id,valid,cancel=false){
  valid();scope('project',projectId);const j=job(id);if(!j||j.board_id!==projectId)throw fail(404,'Media job not found in this project.');
  if(!j.remote_id||['completed','failed','nsfw','canceled'].includes(j.status))return publicJob(j);
  const c=conn(j.provider);if(!c)throw fail(409,'Reconnect this media account to check or cancel its jobs.');
  // Read/cancel existing jobs remains possible after disabling new generation.
  const r=await call(c,operationURL(j.provider,j.remote_id,cancel?j.cancel_url:j.status_url),cancel?(j.provider==='fal'?'PUT':'POST'):'GET');
  let state=cancel?(j.provider==='fal'?'cancellation_requested':'canceled'):({IN_QUEUE:'queued',IN_PROGRESS:'in_progress',COMPLETED:'completed',CANCELLATION_REQUESTED:'cancellation_requested',CANCELED:'canceled',CANCELLED:'canceled'}[r.status]||r.status),result=r;
  if(!['queued','in_progress','completed','failed','nsfw','canceled','cancellation_requested'].includes(state))throw fail(502,'Unknown media job status; check the provider dashboard.');
  if(state==='completed'&&j.provider==='fal')result=await call(c,operationURL(j.provider,j.remote_id,j.response_url));
  if(result.error||result.error_type)state='failed';
  const out=state==='completed'?outputs(result):[];
  db.prepare('UPDATE media_jobs SET status=?,outputs_json=?,updated_at=? WHERE id=?').run(state,JSON.stringify(out),Date.now(),id);valid();return publicJob(job(id));
 }
 const list=(projectId,p)=>{scope('project',projectId);return db.prepare('SELECT * FROM media_jobs WHERE board_id=? AND provider=? ORDER BY created_at DESC LIMIT 30').all(projectId,p).map(publicJob);};
 return {summary,save,grants,assign,forAgent,generate,refresh,list,disconnect:p=>{summary(p);db.prepare('DELETE FROM media_connections WHERE provider=?').run(p);return summary(p);}};
}
function createMediaRoutes(){
 const r=express.Router(),handle=fn=>async(req,res,next)=>{try{const valid=()=>{if(!req.workspaceIsOwner||req.boardlyConnection)throw fail(403,'Only the signed-in account owner can manage media connections.');};valid();res.set('Cache-Control','private, no-store');res.json(await fn(req,req.tenant.media,valid));}catch(e){next(e);}};
 r.get('/api/account/media/:provider',handle((req,s)=>s.summary(req.params.provider)));
 r.put('/api/account/media/:provider',express.json({limit:'16kb'}),handle((req,s)=>s.save(req.params.provider,req.body||{})));
 r.delete('/api/account/media/:provider',handle((req,s)=>s.disconnect(req.params.provider)));
 for(const [plural,kind] of [['companies','company'],['projects','project']]){
  r.get(`/api/${plural}/:id/media/:provider`,handle((req,s)=>({...s.grants(kind,Number(req.params.id),req.params.provider),jobs:kind==='project'?s.list(Number(req.params.id),req.params.provider):[]})));
  r.put(`/api/${plural}/:id/media/:provider`,express.json({limit:'1kb'}),handle((req,s)=>s.assign(kind,Number(req.params.id),req.params.provider,req.body?.enabled)));
 }
 r.post('/api/projects/:id/media/:provider/generate',express.json({limit:'12kb'}),handle((req,s,v)=>s.generate(Number(req.params.id),req.cloudUserId,{...req.body,provider:req.params.provider},v)));
 r.post('/api/projects/:id/media-jobs/:jobId/:action',handle((req,s,v)=>{if(!['refresh','cancel'].includes(req.params.action))throw fail(404,'Unknown media operation.');return s.refresh(Number(req.params.id),req.params.jobId,v,req.params.action==='cancel');}));
 return r;
}
module.exports={createMediaConnectors,createMediaRoutes};
