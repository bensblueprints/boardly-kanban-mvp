const crypto=require('node:crypto');
const express=require('express');
const {accessForMember}=require('./member-access');
const fail=(status,message)=>Object.assign(Error(message),{status});
function trustedOrigin(value){
 if(!value)return '';let u;try{u=new URL(value);}catch{throw Error('Invalid configured ComputerUse origin');}
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('ComputerUse requires a configured HTTPS origin');return u.origin;
}
// Only fixed paths on the configured service origin receive the encrypted key.
async function requestDesktop(origin,token,command,data){
 const paths={account:'/api/v1/account',desktops:'/api/v1/desktops'};
 if(!paths[command]&&!['status','screenshot','lease','release','action'].includes(command))throw fail(400,'Unsupported desktop command');
 try{
  const r=await fetch(origin+(paths[command]||'/api/v1/desktops/'+command),{method:paths[command]?'GET':'POST',headers:{Authorization:'Bearer '+token,Accept:command==='screenshot'?'image/jpeg':'application/json','Content-Type':'application/json'},body:paths[command]?undefined:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!r.ok){const messages={401:'Reconnect ComputerUse: the API key expired or was revoked.',403:'ComputerUse denied access. Check ownership and account:read, desktop:read and desktop:write scopes.',409:'Desktop is busy or under human control. Hand back control in ComputerUse, or wait for the other agent to finish.'};throw fail(r.status,messages[r.status]||'ComputerUse is unavailable. An input may already have occurred; observe before retrying.');}
  let size=0;const parts=[];for await(const part of r.body){size+=part.length;if(size>2000000)throw Error('Too large');parts.push(part);}const raw=Buffer.concat(parts);
  if(command==='screenshot'){if(!r.headers.get('content-type')?.includes('image/jpeg')||raw[0]!==255||raw[1]!==216)throw Error('Invalid screenshot');return {image_url:'data:image/jpeg;base64,'+raw.toString('base64')};}
  if(!r.headers.get('content-type')?.includes('application/json'))throw Error('Invalid response');return JSON.parse(raw.toString('utf8'));
 }catch(e){if(e.status)throw e;throw fail(503,'ComputerUse connection interrupted. An input may already have occurred; observe before retrying.');}
}
async function requestAccount(origin,token){
 const a=await requestDesktop(origin,token,'account');
 const d=await requestDesktop(origin,token,'desktops');return {...a,desktops:d.desktops};
}
function createComputerUseConnections({db,key,namespace,origin='',request=requestAccount,desktopRequest=requestDesktop}){
 origin=trustedOrigin(origin);
 db.exec(`CREATE TABLE IF NOT EXISTS cu_account_connection(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL,encrypted TEXT,account_id TEXT,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cu_assignments(id INTEGER PRIMARY KEY,company_id INTEGER UNIQUE REFERENCES companies(id) ON DELETE CASCADE,board_id INTEGER UNIQUE REFERENCES boards(id) ON DELETE CASCADE,rental_ids TEXT NOT NULL,allow_agent INTEGER NOT NULL DEFAULT 0,revision TEXT NOT NULL,updated_at INTEGER NOT NULL,CHECK((company_id IS NULL)!=(board_id IS NULL)));`);
 // Existing inspection permissions do not silently become input permissions.
 if(!db.prepare('PRAGMA table_info(cu_assignments)').all().some(c=>c.name==='allow_control'))db.exec('ALTER TABLE cu_assignments ADD COLUMN allow_control INTEGER NOT NULL DEFAULT 0');
 const connection=()=>db.prepare('SELECT * FROM cu_account_connection WHERE id=1').get();
 const aad=Buffer.from(JSON.stringify(['computeruse-account-v1',namespace,origin]));
 const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=128&&!/[\x00-\x1f]/.test(x);
 function encrypt(token){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);const body=Buffer.concat([c.update(token,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
 function decrypt(row){try{const data=Buffer.from(row.encrypted,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));c.setAAD(aad);c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8');}catch{throw fail(503,'Reconnect the ComputerUse account.');}}
 function account(data){
  if(!data||!identifier(data.id)||!Array.isArray(data.rentals)||data.rentals.length>1000)throw fail(503,'ComputerUse returned an invalid account.');
  const seen=new Set();const items=data.rentals.map(r=>{if(!r||!identifier(r.id)||seen.has(r.id)||!['standard','creator'].includes(r.plan)||typeof r.state!=='string'||r.state.length>40)throw fail(503,'ComputerUse returned an invalid rental.');seen.add(r.id);return{id:r.id,plan:r.plan,state:r.state,term:typeof r.term==='string'?r.term.slice(0,30):null,period_end:Number.isSafeInteger(r.period_end)?r.period_end:null};});
  if(data.desktops!==undefined&&(!Array.isArray(data.desktops)||data.desktops.length>1000))throw fail(503,'Invalid desktop catalog');
  for(const d of data.desktops||[]){
   if(!d||!identifier(d.id)||!['pilot','rental'].includes(d.kind)||typeof d.available!=='boolean'||!Number.isSafeInteger(d.memory_mib))throw fail(503,'Invalid desktop catalog');
   const id=d.kind==='pilot'?'desktop:'+d.id:d.rental_id;
   if(d.kind==='pilot'&&seen.has(id))throw fail(503,'Duplicate desktop');
   let item=items.find(r=>r.id===id);
   if(d.kind==='pilot'){item={id,plan:d.memory_mib>8192?'creator':'standard',state:d.state,term:null,period_end:null};items.push(item);seen.add(id);}
   if(item)Object.assign(item,{desktop_id:d.id,kind:d.kind,label:typeof d.label==='string'?d.label.slice(0,120):'Desktop',memory_mib:d.memory_mib,vcpus:d.vcpus,disk_gib:d.disk_gib,available:d.available});
  }
  return{id:data.id,rentals:items};
 }
 function accountState(){const r=connection();return{configured:!!origin,saved:!!r?.encrypted,updated_at:r?.updated_at||null,desktop_control_available:true};}
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
 function assignment(kind,id){const s=resolved(kind,id),r=s.effective;return{...accountState(),explicit:!!s.direct,inherited:!!r&&!s.direct,rental_ids:r?JSON.parse(r.rental_ids):[],allow_agent:!!r?.allow_agent,allow_control:!!r?.allow_control,updated_at:r?.updated_at||null};}
 async function assign(kind,id,ids,allowAgent,valid=()=>{},allowControl=false){
  valid();resource(kind,id);if(!Array.isArray(ids)||ids.length>100||ids.some(x=>!identifier(x))||new Set(ids).size!==ids.length||typeof allowAgent!=='boolean'||typeof allowControl!=='boolean')throw fail(400,'Choose up to 100 different active computers and an agent permission.');
  const revision=connection()?.revision,scope=signature(kind,id),items=await rentals(valid);valid();unchanged(revision);if(signature(kind,id)!==scope)throw fail(409,'The assignment or company changed. Refresh and retry.');
  if(ids.some(id=>!items.some(r=>r.id===id&&r.state==='active')))throw fail(403,'Only active computers owned by the connected ComputerUse account can be assigned.');
  const field=kind==='company'?'company_id':'board_id';
  db.prepare(`INSERT INTO cu_assignments(${field},rental_ids,allow_agent,allow_control,revision,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(${field}) DO UPDATE SET rental_ids=excluded.rental_ids,allow_agent=excluded.allow_agent,allow_control=excluded.allow_control,revision=excluded.revision,updated_at=excluded.updated_at`).run(id,JSON.stringify(ids),Number(allowAgent&&ids.length>0),Number(allowAgent&&allowControl&&ids.length>0),crypto.randomUUID(),Date.now());return assignment(kind,id);
 }
 function clear(kind,id){resource(kind,id);db.prepare(`DELETE FROM cu_assignments WHERE ${kind==='company'?'company_id':'board_id'}=?`).run(id);return assignment(kind,id);}
 function enabled(id){const a=assignment('project',id);return a.configured&&a.saved&&a.allow_agent&&a.rental_ids.length>0;}
 async function inspectForAgent(id,actor,valid=()=>{}){
  valid();if(!enabled(id))throw fail(403,'No ComputerUse computers are enabled for agents in this project.');const a=assignment('project',id),scope=signature('project',id),items=await rentals(valid);valid();if(signature('project',id)!==scope)throw fail(409,'Computer assignment changed. Retry.');const selected=items.filter(r=>a.rental_ids.includes(r.id)&&r.state==='active');if(selected.length!==a.rental_ids.length)throw fail(403,'An assigned rental is no longer active. Refresh the assignment.');return{rentals:selected,inherited:a.inherited,desktop_control_available:true,message:'Owned computers verified. Use desktop status before control; human takeover pauses agents.'};
 }
 // A lease belongs to one Work run, never to every agent sharing the API key.
 const leases=new Map(),busy=new Set(),uncertain=new Set();
 async function controlForAgent(id,actor,runId,command,data,valid=()=>{}){
  if(!['status','screenshot','action','release'].includes(command)||!identifier(data?.desktop_id)||!identifier(runId))throw fail(400,'Invalid desktop request');
  const desktopId=data.desktop_id;
  if(busy.has(desktopId))throw fail(409,'Another desktop operation is in progress');busy.add(desktopId);
  try{
   valid();const revision=connection()?.revision,scope=signature('project',id);
   const selected=await inspectForAgent(id,actor,valid);
   if(!selected.rentals.some(r=>r.desktop_id===desktopId&&r.available))throw fail(403,'This desktop is not available to this project');
   const check=()=>{valid();unchanged(revision);if(signature('project',id)!==scope||!enabled(id))throw fail(403,'Computer assignment changed');};
   check();const token=decrypt(connection()),send=async(c,d)=>{check();const result=await desktopRequest(origin,token,c,{desktop_id:desktopId,...d});check();return result;};
   if(command==='status')return await send('status',{});
   if(!assignment('project',id).allow_control)throw fail(403,'Enable desktop control in the company or project computer assignment.');
   let held=leases.get(desktopId);
   if(held&&held.expires*1000<=Date.now()){leases.delete(desktopId);held=null;}
   if(held&&(held.runId!==runId||held.projectId!==id||held.actor!==actor||held.revision!==revision))throw fail(409,'Another Work agent is using this desktop');
   if(command==='release'){
    if(!held)return {released:false};try{return await send('release',{lease:held.lease});}finally{leases.delete(desktopId);}
   }
   if(command==='action'&&uncertain.has(desktopId))throw fail(409,'Previous input outcome is uncertain. Take a fresh screenshot before choosing another action.');
   const lease=await send('lease',held?{lease:held.lease}:{});
   if(typeof lease.lease!=='string'||!Number.isSafeInteger(lease.expires))throw fail(503,'Invalid desktop lease');
   leases.set(desktopId,{runId,projectId:id,actor,revision,lease:lease.lease,expires:lease.expires});
   if(command==='screenshot'){const image=await send('screenshot',{});uncertain.delete(desktopId);return image;}
   if(typeof data.operation_id!=='string'||!/^[0-9a-f-]{36}$/.test(data.operation_id)||!data.action||JSON.stringify(data.action).length>20000)throw fail(400,'Invalid desktop action');
   try{return await send('action',{lease:lease.lease,operation_id:data.operation_id,action:data.action});}catch(e){uncertain.add(desktopId);throw e;}
  }finally{busy.delete(desktopId);}
 }
 async function releaseRun(runId){
  for(const [desktopId,held] of leases){if(held.runId!==runId)continue;
   try{const row=connection();if(row?.revision===held.revision)await desktopRequest(origin,decrypt(row),'release',{desktop_id:desktopId,lease:held.lease});}catch{/* The remote lease expires after 60 seconds; never force human handback. */}
   finally{if(leases.get(desktopId)===held)leases.delete(desktopId);}
  }
 }
 return{accountState,connect,disconnect:reset,rentals,assignment,assign,clear,enabled,inspectForAgent,controlForAgent,releaseRun};
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
  router.put(base,express.json({limit:'16kb'}),handler(kind,async(req,res,s,id,v)=>res.json(await s.assign(kind,id,req.body?.rental_ids,req.body?.allow_agent,v,req.body?.allow_control??false))));
  router.delete(base,handler(kind,async(req,res,s,id)=>res.json(s.clear(kind,id))));
 }
 return router;
}
module.exports={trustedOrigin,requestAccount,requestDesktop,createComputerUseConnections,createComputerUseRoutes};
