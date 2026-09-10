const crypto=require('node:crypto');
const express=require('express');
const {accessForMember}=require('./member-access');
const fail=(status,message)=>Object.assign(Error(message),{status});
function trustedOrigin(value){
 if(!value)return '';let u;try{u=new URL(value);}catch{throw Error('Invalid configured ComputerUse origin');}
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('ComputerUse requires a configured HTTPS origin');return u.origin;
}
async function requestAccount(origin,token){
 try{
  const r=await fetch(origin+'/api/v1/account',{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!r.ok||!r.headers.get('content-type')?.includes('application/json'))throw Error('Unavailable');
  let size=0;const parts=[];for await(const part of r.body){size+=part.length;if(size>1024*1024)throw Error('Too large');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }catch{throw fail(503,'ComputerUse could not verify this account. Check the API key, account:read permission and service availability.');}
}
function createComputerUseConnections({db,key,namespace,origin='',request=requestAccount}){
 origin=trustedOrigin(origin);
 db.exec(`CREATE TABLE IF NOT EXISTS cu_account_connection(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL,encrypted TEXT,account_id TEXT,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cu_assignments(id INTEGER PRIMARY KEY,company_id INTEGER UNIQUE REFERENCES companies(id) ON DELETE CASCADE,board_id INTEGER UNIQUE REFERENCES boards(id) ON DELETE CASCADE,rental_ids TEXT NOT NULL,allow_agent INTEGER NOT NULL DEFAULT 0,revision TEXT NOT NULL,updated_at INTEGER NOT NULL,CHECK((company_id IS NULL)!=(board_id IS NULL)));`);
 const connection=()=>db.prepare('SELECT * FROM cu_account_connection WHERE id=1').get();
 const aad=Buffer.from(JSON.stringify(['computeruse-account-v1',namespace,origin]));
 const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=128&&!/[\x00-\x1f]/.test(x);
 function encrypt(token){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);const body=Buffer.concat([c.update(token,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
 function decrypt(row){try{const data=Buffer.from(row.encrypted,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));c.setAAD(aad);c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8');}catch{throw fail(503,'Reconnect the ComputerUse account.');}}
 function account(data){
  if(!data||!identifier(data.id)||!Array.isArray(data.rentals)||data.rentals.length>1000)throw fail(503,'ComputerUse returned an invalid account.');
  const seen=new Set();return{id:data.id,rentals:data.rentals.map(r=>{if(!r||!identifier(r.id)||seen.has(r.id)||!['standard','creator'].includes(r.plan)||typeof r.state!=='string'||r.state.length>40)throw fail(503,'ComputerUse returned an invalid rental.');seen.add(r.id);return{id:r.id,plan:r.plan,state:r.state,term:typeof r.term==='string'?r.term.slice(0,30):null,period_end:Number.isSafeInteger(r.period_end)?r.period_end:null};})};
 }
 function accountState(){const r=connection();return{configured:!!origin,saved:!!r?.encrypted,updated_at:r?.updated_at||null,desktop_control_available:false};}
 function unchanged(revision){if(connection()?.revision!==revision)throw fail(409,'The ComputerUse account changed. Refresh and retry.');}
 function reset(){db.transaction(()=>{db.prepare('INSERT INTO cu_account_connection(id,revision,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,encrypted=NULL,account_id=NULL,updated_at=excluded.updated_at').run(crypto.randomUUID(),Date.now());db.prepare('DELETE FROM cu_assignments').run();})();return accountState();}
 async function connect(token,valid=()=>{}){
  valid();if(!origin)throw fail(503,'ComputerUse is not configured.');if(typeof token!=='string'||token.length<16||token.length>256||/\s/.test(token))throw fail(400,'Enter a valid ComputerUse API key.');
  reset();const revision=connection().revision;const a=account(await request(origin,token));valid();unchanged(revision);
  db.prepare('UPDATE cu_account_connection SET encrypted=?,account_id=?,updated_at=? WHERE id=1 AND revision=?').run(encrypt(token),a.id,Date.now(),revision);return accountState();
 }
 async function rentals(valid=()=>{}){valid();const r=connection();if(!origin||!r?.encrypted)throw fail(404,'Connect ComputerUse in account settings first.');const a=account(await request(origin,decrypt(r)));valid();unchanged(r.revision);if(a.id!==r.account_id)throw fail(403,'ComputerUse account identity changed. Reconnect the intended account.');return a.rentals;}
 function resource(kind,id){
  if(!['company','project'].includes(kind)||!Number.isSafeInteger(id)||id<1)throw fail(404,'Company or project not found');
  if(kind==='company'){if(!db.prepare('SELECT id FROM companies WHERE id=?').get(id))throw fail(404,'Company not found');return id;}
  if(!db.prepare('SELECT id FROM boards WHERE id=?').get(id))throw fail(404,'Project not found');
  return db.prepare('SELECT b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(id)?.company_id??null;
 }
 function own(kind,id){return db.prepare(`SELECT * FROM cu_assignments WHERE ${kind==='company'?'company_id':'board_id'}=?`).get(id);}
 function resolved(kind,id){const companyId=resource(kind,id),direct=own(kind,id);return{companyId,direct,effective:direct||(kind==='project'&&companyId?own('company',companyId):null)};}
 function signature(kind,id){const s=resolved(kind,id);return JSON.stringify([s.companyId,s.direct?.revision||null,s.effective?.revision||null]);}
 function assignment(kind,id){const s=resolved(kind,id),r=s.effective;return{...accountState(),explicit:!!s.direct,inherited:!!r&&!s.direct,rental_ids:r?JSON.parse(r.rental_ids):[],allow_agent:!!r?.allow_agent,updated_at:r?.updated_at||null};}
 async function assign(kind,id,ids,allowAgent,valid=()=>{}){
  valid();resource(kind,id);if(!Array.isArray(ids)||ids.length>100||ids.some(x=>!identifier(x))||new Set(ids).size!==ids.length||typeof allowAgent!=='boolean')throw fail(400,'Choose up to 100 different active rentals and an agent permission.');
  const revision=connection()?.revision,scope=signature(kind,id),items=await rentals(valid);valid();unchanged(revision);if(signature(kind,id)!==scope)throw fail(409,'The assignment or company changed. Refresh and retry.');
  if(ids.some(id=>!items.some(r=>r.id===id&&r.state==='active')))throw fail(403,'Only active rentals owned by the connected ComputerUse account can be assigned.');
  const field=kind==='company'?'company_id':'board_id';
  db.prepare(`INSERT INTO cu_assignments(${field},rental_ids,allow_agent,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(${field}) DO UPDATE SET rental_ids=excluded.rental_ids,allow_agent=excluded.allow_agent,revision=excluded.revision,updated_at=excluded.updated_at`).run(id,JSON.stringify(ids),Number(allowAgent&&ids.length>0),crypto.randomUUID(),Date.now());return assignment(kind,id);
 }
 function clear(kind,id){resource(kind,id);db.prepare(`DELETE FROM cu_assignments WHERE ${kind==='company'?'company_id':'board_id'}=?`).run(id);return assignment(kind,id);}
 function enabled(id){const a=assignment('project',id);return a.configured&&a.saved&&a.allow_agent&&a.rental_ids.length>0;}
 async function inspectForAgent(id,actor,valid=()=>{}){
  valid();if(!enabled(id))throw fail(403,'No ComputerUse rentals are enabled for agents in this project.');const a=assignment('project',id),scope=signature('project',id),items=await rentals(valid);valid();if(signature('project',id)!==scope)throw fail(409,'Computer assignment changed. Retry.');const selected=items.filter(r=>a.rental_ids.includes(r.id)&&r.state==='active');if(selected.length!==a.rental_ids.length)throw fail(403,'An assigned rental is no longer active. Refresh the assignment.');return{rentals:selected,inherited:a.inherited,desktop_control_available:false,message:'Rental ownership verified. Screen control is awaiting the worker desktop service.'};
 }
 return{accountState,connect,disconnect:reset,rentals,assignment,assign,clear,enabled,inspectForAgent};
}
function createComputerUseRoutes({memberships}){
 const router=express.Router(),accountBase='/api/account/computeruse';
 function verify(req,kind,id){
  if(!req.tenant||!req.cloudUserId)throw fail(401,'Sign in first');
  if(kind==='account'){if(!req.workspaceIsOwner)throw fail(403,'The account owner manages the ComputerUse API key.');return;}
  const db=req.tenant.app.db;if(!db.prepare(`SELECT id FROM ${kind==='company'?'companies':'boards'} WHERE id=?`).get(id))throw fail(404,'Company or project not found');
  if(!req.workspaceIsOwner){const access=accessForMember(db,memberships.grants(req.workspaceOwnerId,req.cloudUserId));if(!access[kind](id))throw fail(404,'Company or project not found');if(!access.capabilities(kind,id).includes('computers'))throw fail(403,'The owner must enable your Computer use member permission.');}
 }
 const handler=(kind,fn)=>async(req,res,next)=>{try{const id=kind==='account'?null:Number(req.params.id),valid=()=>verify(req,kind,id);valid();res.set('Cache-Control','private, no-store');await fn(req,res,req.tenant.computeruse,id,valid);}catch(e){next(e);}};
 router.get(accountBase,handler('account',async(req,res,s)=>res.json(s.accountState())));
 router.put(accountBase,express.json({limit:'4kb'}),handler('account',async(req,res,s,id,v)=>res.json(await s.connect(req.body?.token,v))));
 router.delete(accountBase,handler('account',async(req,res,s)=>res.json(s.disconnect())));
 router.get(accountBase+'/rentals',handler('account',async(req,res,s,id,v)=>res.json({rentals:await s.rentals(v)})));
 for(const [plural,kind] of [['companies','company'],['projects','project']]){
  const base=`/api/${plural}/:id/computeruse`;
  router.get(base,handler(kind,async(req,res,s,id)=>res.json({...s.assignment(kind,id),can_manage_account:req.workspaceIsOwner})));
  router.get(base+'/rentals',handler(kind,async(req,res,s,id,v)=>res.json({rentals:await s.rentals(v)})));
  router.put(base,express.json({limit:'16kb'}),handler(kind,async(req,res,s,id,v)=>res.json(await s.assign(kind,id,req.body?.rental_ids,req.body?.allow_agent,v))));
  router.delete(base,handler(kind,async(req,res,s,id)=>res.json(s.clear(kind,id))));
 }
 return router;
}
module.exports={trustedOrigin,requestAccount,createComputerUseConnections,createComputerUseRoutes};
