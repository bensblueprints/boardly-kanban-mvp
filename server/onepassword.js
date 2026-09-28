const crypto=require('node:crypto');
const express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
const bounded=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f]/.test(v);
function loginUrl(value){
 let u;try{u=new URL(value);}catch{throw fail(400,'Enter the complete HTTPS login URL.');}
 if(u.protocol!=='https:'||u.username||u.password||u.hash||value.length>2000)throw fail(400,'Use an HTTPS login URL without credentials or a fragment.');
 return u.href;
}
function reference(value){
 // ID references avoid a renamed/duplicated item silently selecting another login.
 if(typeof value!=='string'||!/^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/(?:[a-zA-Z0-9_-]{1,100}\/)?[a-zA-Z0-9_-]{1,100}$/.test(value))throw fail(400,'Use an op:// secret reference containing the vault ID, item ID and field ID.');
 return value;
}
async function timed(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('1Password timeout')),20000);})]);}finally{clearTimeout(timer);}}
async function sdkClient(token){
 try{return await timed(require('@1password/sdk').createClient({auth:token,integrationName:'Boardly ComputerUse',integrationVersion:'v1.0.0'}));}
 catch{throw fail(502,'1Password could not authenticate. Check the service account token and vault permissions.');}
}
function createOnePassword({db,key,namespace,client=sdkClient}){
 db.exec(`CREATE TABLE IF NOT EXISTS op_connection(id INTEGER PRIMARY KEY CHECK(id=1),encrypted TEXT NOT NULL,revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS op_logins(id TEXT PRIMARY KEY,label TEXT NOT NULL,url TEXT NOT NULL,username_ref TEXT,password_ref TEXT NOT NULL,revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS op_grants(id INTEGER PRIMARY KEY,company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,login_id TEXT NOT NULL REFERENCES op_logins(id) ON DELETE CASCADE,CHECK((company_id IS NULL)!=(board_id IS NULL)),UNIQUE(company_id,login_id),UNIQUE(board_id,login_id));
 CREATE TABLE IF NOT EXISTS op_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,board_id INTEGER,login_id TEXT,desktop_id TEXT,operation TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 const connection=()=>db.prepare('SELECT * FROM op_connection WHERE id=1').get();
 const aad=Buffer.from('onepassword:'+namespace);
 const seal=value=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);return Buffer.concat([iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]).toString('base64');};
 const unseal=value=>{const b=Buffer.from(value,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(aad);c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8');};
 const logins=()=>db.prepare('SELECT * FROM op_logins ORDER BY label').all().map(({revision,...row})=>row);
 const summary=()=>({saved:!!connection(),logins:logins(),audit:db.prepare('SELECT actor,board_id,login_id,desktop_id,operation,state,created_at FROM op_audit ORDER BY created_at DESC LIMIT 30').all()});
 async function connect(token,valid=()=>{}){
  valid();if(!bounded(token,12000)||!token.startsWith('ops_'))throw fail(400,'Paste a 1Password service account token, starting with ops_.');
  const old=connection()?.revision;
  try{const c=await client(token);await timed(c.vaults.list());}catch{throw fail(502,'1Password connection failed. Check that the service account can read your automation vault.');}
  valid();if(connection()?.revision!==old)throw fail(409,'Connection changed; refresh before retrying.');
  db.prepare('INSERT INTO op_connection VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,revision=excluded.revision').run(seal(token),crypto.randomUUID());return summary();
 }
 function saveLogin(data){
  if(!connection())throw fail(409,'Connect 1Password first.');
  if(!bounded(data.label,100))throw fail(400,'Give this login a name.');
  const url=loginUrl(data.url),password=reference(data.password_ref),username=data.username_ref?reference(data.username_ref):null;
  if(username&&username.split('/').slice(0,4).join('/')!==password.split('/').slice(0,4).join('/'))throw fail(400,'Username and password must come from the same vault item.');
  const id=crypto.randomUUID();db.prepare('INSERT INTO op_logins VALUES(?,?,?,?,?,?)').run(id,data.label.trim(),url,username,password,crypto.randomUUID());return summary();
 }
 async function browse(vaultId,valid=()=>{}){
  valid();const conn=connection();if(!conn)throw fail(409,'Connect 1Password first.');
  if(vaultId&&!/^[a-z0-9]{26}$/.test(vaultId))throw fail(400,'Choose a vault.');
  let result;
  try{
   const c=await client(unseal(conn.encrypted));
   // Item overviews contain metadata, not password values. Never return an SDK
   // object wholesale: only the chosen names, IDs and HTTPS origins may leave.
   if(!vaultId)result={vaults:(await timed(c.vaults.list({decryptDetails:true}))).slice(0,200).map(v=>({id:v.id,title:String(v.title||'Vault').slice(0,200)}))};
   else result={items:(await timed(c.items.list(vaultId))).filter(i=>i.state!=='archived'&&(i.category==='Login'||i.category==='Password')).slice(0,1000).map(i=>({id:i.id,title:String(i.title||'Login').slice(0,200),username:i.category==='Login',origins:(i.websites||[]).flatMap(w=>{try{return[new URL(loginUrl(w.url)).origin];}catch{return[];}})}))};
  }catch{throw fail(502,'Could not list this vault. Check the service account read permissions.');}
  valid();if(connection()?.revision!==conn.revision)throw fail(409,'Connection changed; refresh before retrying.');return result;
 }
 function scope(kind,id){
  const table=kind==='company'?'companies':'boards';if(!Number.isSafeInteger(id)||!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id))throw fail(404,'Company or project not found.');
  return kind==='project'?require('./hierarchy').createHierarchy(db).scope(id)?.company_id:null;
 }
 function grants(kind,id){
  const companyId=scope(kind,id),field=kind==='company'?'company_id':'board_id';
  const own=db.prepare(`SELECT login_id FROM op_grants WHERE ${field}=?`).all(id).map(x=>x.login_id);
  const inherited=companyId?db.prepare('SELECT login_id FROM op_grants WHERE company_id=?').all(companyId).map(x=>x.login_id):[];
  return {saved:!!connection(),login_ids:own,inherited_ids:inherited,logins:logins().map(({id,label,url})=>({id,label,url}))};
 }
 function assign(kind,id,ids){
  scope(kind,id);if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!db.prepare('SELECT id FROM op_logins WHERE id=?').get(id)))throw fail(400,'Choose existing approved logins.');
  const field=kind==='company'?'company_id':'board_id';db.transaction(()=>{db.prepare(`DELETE FROM op_grants WHERE ${field}=?`).run(id);for(const loginId of ids)db.prepare(`INSERT INTO op_grants(${field},login_id) VALUES(?,?)`).run(id,loginId);})();return grants(kind,id);
 }
 function forAgent(id){const g=grants('project',id),ids=new Set([...g.login_ids,...g.inherited_ids]);return g.saved?g.logins.filter(l=>ids.has(l.id)).map(l=>({id:l.id,label:l.label,origin:new URL(l.url).origin})):[];}
 async function use({projectId,actor,desktopId,loginId,operationId,mode,field,valid,send}){
  if(!['open','fill'].includes(mode)||mode==='fill'&&!['username','password'].includes(field))throw fail(400,'Choose open, or fill username/password.');
  const row=db.prepare('SELECT * FROM op_logins WHERE id=?').get(loginId),conn=connection();
  function check(){valid();if(!conn||connection()?.revision!==conn.revision||!row||db.prepare('SELECT revision FROM op_logins WHERE id=?').get(loginId)?.revision!==row.revision||!forAgent(projectId).some(l=>l.id===loginId))throw fail(403,'This login is not approved for this project, or its access changed.');}
  check();let value;
  db.prepare('INSERT INTO op_audit VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),actor,projectId,loginId,desktopId,mode+(field?':'+field:''),'requested',Date.now());
  try{
   if(mode==='fill'){
    const ref=field==='username'?row.username_ref:row.password_ref;if(!ref)throw fail(400,'No username field is configured for this login.');
    try{const c=await client(unseal(conn.encrypted));value=await timed(c.secrets.resolve(ref));}catch{throw fail(502,'1Password could not read this approved field. Check the item IDs and service account access.');}
    if(!bounded(value,4096))throw fail(400,'The approved field is empty or is not a supported login value.');
   }
   check();await send({operation_id:operationId,login:{mode,url:row.url,origin:new URL(row.url).origin,...(mode==='fill'?{field,value}:{})}},check);
   check();db.prepare('INSERT INTO op_audit VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),actor,projectId,loginId,desktopId,mode+(field?':'+field:''),'completed',Date.now());
   // Never return SDK objects, references, credential values or provider errors to an agent.
   return {login_id:loginId,state:mode==='open'?'browser_opened':'filled',field:mode==='fill'?field:undefined,submitted:false};
  }catch(e){db.prepare('INSERT INTO op_audit VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),actor,projectId,loginId,desktopId,mode,'failed',Date.now());throw fail(e.status||502,e.status?e.message:'Login could not complete. Observe the desktop before retrying.');}
  finally{value=undefined;}
 }
 return {summary,connect,saveLogin,browse,grants,assign,forAgent,use,disconnect:()=>{db.prepare('DELETE FROM op_connection').run();return summary();},removeLogin:id=>{db.prepare('DELETE FROM op_logins WHERE id=?').run(id);return summary();}};
}
function createOnePasswordRoutes(){
 const r=express.Router();
 const handle=fn=>async(req,res,next)=>{try{const valid=()=>{if(!req.workspaceIsOwner||!req.cloudUserId||req.boardlyConnection)throw fail(403,'Only the signed-in account owner can manage 1Password.');};valid();res.set('Cache-Control','private, no-store');res.json(await fn(req,req.tenant.onepassword,valid));}catch(e){next(e);}};
 r.get('/api/account/onepassword',handle((req,s)=>s.summary()));
 r.put('/api/account/onepassword',express.json({limit:'16kb'}),handle((req,s,v)=>s.connect(req.body?.token,v)));
 r.delete('/api/account/onepassword',handle((req,s)=>s.disconnect()));
 r.get('/api/account/onepassword/vaults',handle((req,s,v)=>s.browse(null,v)));
 r.get('/api/account/onepassword/vaults/:vaultId/items',handle((req,s,v)=>s.browse(req.params.vaultId,v)));
 r.post('/api/account/onepassword/logins',express.json({limit:'8kb'}),handle((req,s)=>s.saveLogin(req.body||{})));
 r.delete('/api/account/onepassword/logins/:loginId',handle((req,s)=>s.removeLogin(req.params.loginId)));
 for(const [plural,kind] of [['companies','company'],['projects','project']]){
  r.get(`/api/${plural}/:id/onepassword`,handle((req,s)=>s.grants(kind,Number(req.params.id))));
  r.put(`/api/${plural}/:id/onepassword`,express.json({limit:'8kb'}),handle((req,s)=>s.assign(kind,Number(req.params.id),req.body?.login_ids)));
 }
 return r;
}
module.exports={createOnePassword,createOnePasswordRoutes,loginUrl,reference};
