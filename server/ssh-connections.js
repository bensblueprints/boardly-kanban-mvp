const crypto=require('node:crypto'),express=require('express');
const {redact}=require('./project-environment');
const {safeText}=require('./agent-activity');
const fail=(status,message)=>Object.assign(Error(message),{status});
function connectSSH(config,{command,forward,valid=()=>true,timeout=30000}={}){
 return new Promise((resolve,reject)=>{
  const {Client}=require('ssh2'),client=new Client();let ended=false,stdout='',stderr='',truncated=false;
  const finish=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);clearInterval(check);client.end();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>finish(fail(504,'SSH timed out. A remote command may still be running; inspect before retrying.')),Math.min(timeout,45000));
  const check=setInterval(()=>{if(!valid())finish(fail(403,'SSH permission or run access was removed'));},1000);
  client.on('error',()=>finish(fail(502,'SSH connection failed. Check credentials, network access and the pinned host fingerprint.')));
  client.on('close',()=>{if(!ended)finish(fail(502,'SSH disconnected. Inspect the remote result before retrying.'));});
  client.on('ready',()=>{
   if(!valid())return finish(fail(403,'SSH permission was removed'));
   if(forward)return client.forwardOut('127.0.0.1',0,forward.host,forward.port,(err,sock)=>{if(err)return finish(fail(502,'SSH jump host could not reach the destination'));ended=true;clearTimeout(timer);clearInterval(check);sock.once('close',()=>client.end());resolve({sock,close:()=>{sock.destroy();client.end();}});});
   if(command===undefined)return finish(null,{connected:true});
   client.exec(command,(err,stream)=>{
    if(err)return finish(fail(502,'SSH command could not start'));
    stream.on('data',d=>{if(stdout.length+stderr.length<100000)stdout+=d.toString();else truncated=true;});
    stream.stderr.on('data',d=>{if(stdout.length+stderr.length<100000)stderr+=d.toString();else truncated=true;});
    stream.on('error',()=>finish(fail(502,'SSH command stream ended unexpectedly')));
    stream.on('close',(code,signal)=>finish(null,{code:code??null,signal:signal||null,stdout:safeText(redact(stdout,{private_key:config.private_key,password:config.password,passphrase:config.passphrase})),stderr:safeText(redact(stderr,{private_key:config.private_key,password:config.password,passphrase:config.passphrase})),truncated}));
   });
  });
  try{client.connect({host:config.host,port:config.port,username:config.username,...(config.sock?{sock:config.sock}:{}),
   ...(config.auth_type==='key'?{privateKey:config.private_key,passphrase:config.passphrase||undefined}:{password:config.password}),
   readyTimeout:10000,keepaliveInterval:5000,keepaliveCountMax:2,
   hostVerifier:key=>'SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===config.fingerprint});}
  catch{finish(fail(400,'SSH credentials or connection settings are invalid'));}
 });
}
function createSshConnections({db,key,namespace,connector=connectSSH,tailnet,members=()=>[]}){
 const direct=async(config,options)=>{if(!config.fingerprint)throw fail(400,'Add the trusted host fingerprint before connecting');if(config.tailnet_device_id){if(!tailnet)throw fail(503,'Tailscale is not configured');const sock=await tailnet.dial(config.tailnet_account,config.tailnet_device_id,config.port);try{const result=await connector({...config,sock},options);if(options.forward)return {...result,close:()=>{result.close();sock.destroy();}};sock.destroy();return result;}catch(e){sock.destroy();throw e;}}return connector(config,options);};
 db.exec(`CREATE TABLE IF NOT EXISTS ssh_connections (
 id TEXT PRIMARY KEY,company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
 project_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,label TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,
 username TEXT NOT NULL,auth_type TEXT NOT NULL,fingerprint TEXT NOT NULL,encrypted TEXT NOT NULL,
 allow_agent INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,tested_at INTEGER,
 CHECK((company_id IS NULL)!=(project_id IS NULL)));`);
 // Separate owner library keeps existing scoped records and their encryption AAD intact.
 db.exec(`CREATE TABLE IF NOT EXISTS owner_ssh_connections AS SELECT * FROM ssh_connections WHERE 0;
 CREATE UNIQUE INDEX IF NOT EXISTS owner_ssh_id ON owner_ssh_connections(id);`);
 for(const table of ['ssh_connections','owner_ssh_connections'])for(const column of ['tailnet_account','tailnet_device_id','jump_id'])if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
 const table=kind=>kind==='owner'?'owner_ssh_connections':'ssh_connections';
 const all='(SELECT * FROM ssh_connections UNION ALL SELECT * FROM owner_ssh_connections)';
 db.exec(`CREATE TABLE IF NOT EXISTS ssh_access(connection_id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN ('shared','owner','assigned')),member_ids TEXT NOT NULL);`);
 const access=id=>{const r=db.prepare('SELECT mode,member_ids FROM ssh_access WHERE connection_id=?').get(id);return r?{mode:r.mode,member_ids:JSON.parse(r.member_ids)}:{mode:'shared',member_ids:[]};};
 function permitted(id,actor=namespace){if(actor===namespace)return true;const a=access(id);return a.mode==='shared'||(a.mode==='assigned'&&members().some(m=>m.user_id===actor&&a.member_ids.includes(m.id)));}
 function requireAccess(id,actor){if(!permitted(id,actor))throw fail(403,'This computer is not assigned to you');}
 const visible=(rows,actor=namespace)=>rows.filter(r=>permitted(r.id,actor)).map(r=>({...r,...(actor===namespace?{access:access(r.id)}:{})}));
 function setAccess(kind,id,cid,value,actor){
  if(actor!==namespace)throw fail(403,'Only the account owner can assign computers');
  const r=row(kind,id,cid);
  if(!value||!['shared','owner','assigned'].includes(value.mode)||!Array.isArray(value.member_ids))throw fail(400,'Choose shared, owner-only, or assigned member access');
  const ids=[...new Set(value.member_ids)],known=new Set(members().map(m=>m.id));
  if(ids.some(id=>typeof id!=='string'||!known.has(id))||(value.mode==='assigned'&&!ids.length))throw fail(400,'Choose at least one current account member');
  db.transaction(()=>{db.prepare('INSERT INTO ssh_access VALUES (?,?,?) ON CONFLICT(connection_id) DO UPDATE SET mode=excluded.mode,member_ids=excluded.member_ids').run(cid,value.mode,JSON.stringify(value.mode==='assigned'?ids:[]));db.prepare(`UPDATE ${table(kind)} SET updated_at=? WHERE id=?`).run(Math.max(Date.now(),r.updated_at+1),cid);})();
  return {...list(kind,id).find(c=>c.id===cid),access:access(cid)};
 }
 const columns='id,company_id,project_id,label,host,port,username,auth_type,fingerprint,allow_agent,created_at,updated_at,tested_at,tailnet_device_id,jump_id';
 const aad=r=>Buffer.from(JSON.stringify(['ssh',namespace,r.id,r.company_id,r.project_id]));
 const decrypt=r=>{const b=Buffer.from(r.encrypted,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(aad(r));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());};
 const encrypt=(r,secrets)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad(r));const bytes=Buffer.concat([c.update(JSON.stringify(secrets)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64');};
 const field=kind=>kind==='companies'?'company_id':'project_id';
 const where=kind=>kind==='owner'?'company_id IS NULL AND project_id IS NULL':`${field(kind)}=?`;
 const params=(kind,id)=>kind==='owner'?[]:[id];
 function scope(kind,id){if(kind==='owner')return;if(!['companies','projects'].includes(kind)||!db.prepare(`SELECT id FROM ${kind==='companies'?'companies':'boards'} WHERE id=?`).get(id))throw fail(404,'SSH scope not found');}
 const list=(kind,id)=>{scope(kind,id);return db.prepare(`SELECT ${columns} FROM ${table(kind)} WHERE ${where(kind)} ORDER BY label,id`).all(...params(kind,id));};
 const row=(kind,id,cid)=>{scope(kind,id);const r=db.prepare(`SELECT * FROM ${table(kind)} WHERE id=? AND ${where(kind)}`).get(cid,...params(kind,id));if(!r)throw fail(404,'SSH connection not found');return r;};
 function chain(config,requireEnabled=false){
  const hops=[],seen=new Set([config.id]);let current=config;
  while(current.jump_id){if(seen.has(current.jump_id)||hops.length>=4)throw fail(400,'Invalid SSH jump-host chain');seen.add(current.jump_id);
   const hop=db.prepare('SELECT * FROM owner_ssh_connections WHERE id=?').get(current.jump_id);
   if(!hop||(requireEnabled&&!hop.allow_agent))throw fail(403,'SSH jump host is missing or disabled');hops.unshift({...hop,...decrypt(hop)});current=hop;
  }return hops;
 }
 async function execute(config,options={}){
  const hops=chain(config,!!options.requireEnabled),handles=[];
  const valid=()=>{if(options.valid&&!options.valid())return false;try{return chain(config,!!options.requireEnabled).every((h,i)=>h.id===hops[i]?.id&&h.updated_at===hops[i]?.updated_at);}catch{return false;}};
  try{let sock;
   for(let i=0;i<hops.length;i++){if(!valid())throw fail(403,'SSH permission was removed');const next=hops[i+1]||config;const handle=await direct({...hops[i],...(sock?{sock}: {})},{...options,valid,command:undefined,forward:{host:next.host,port:next.port}});handles.push(handle);sock=handle.sock;}
   if(!valid())throw fail(403,'SSH permission was removed');return await direct({...config,...(sock?{sock}: {})},{...options,valid});
  }finally{for(const handle of handles.reverse())handle.close();}
 }
 function save(kind,id,data,cid,network){
  scope(kind,id);const old=cid?row(kind,id,cid):null,r={...old,...data,id:old?.id||crypto.randomUUID(),company_id:kind==='companies'?Number(id):null,project_id:kind==='projects'?Number(id):null};
  for(const name of ['label','host','username'])if(typeof r[name]!=='string'||!r[name].trim()||r[name].length>254||/[\s\x00-\x1f]/.test(name==='label'?'':r[name]))throw fail(400,`Enter a valid ${name}`);
  if(!/^[a-z0-9._:[\]-]+$/i.test(r.host))throw fail(400,'Enter an SSH hostname or IP address');
  r.port=Number(r.port??22);if(!Number.isInteger(r.port)||r.port<1||r.port>65535)throw fail(400,'Enter an SSH port from 1 to 65535');
  if(!['key','password'].includes(r.auth_type))throw fail(400,'Choose a private key or password');
  if(typeof r.fingerprint!=='string'||(!/^SHA256:[a-zA-Z0-9+/]{43}$/.test(r.fingerprint)&&!(r.fingerprint===''&&!(data.allow_agent===undefined?old?.allow_agent:data.allow_agent))))throw fail(400,'Enter the trusted server host fingerprint (SHA256:…)');
  if(data.allow_agent!==undefined&&typeof data.allow_agent!=='boolean')throw fail(400,'Agent access must be on or off');
  const previous=old?decrypt(old):{},secrets={};
  for(const name of ['private_key','passphrase','password']){secrets[name]=data[name]||previous[name]||'';if(typeof secrets[name]!=='string'||secrets[name].length>32000||secrets[name].includes('\0'))throw fail(400,'Invalid SSH credential');}
  if(r.auth_type==='key'){if(!secrets.private_key)throw fail(400,'Enter a private SSH key');const parsed=require('ssh2').utils.parseKey(secrets.private_key,secrets.passphrase||undefined);if(parsed instanceof Error)throw fail(400,'Private key or passphrase is invalid');secrets.password='';}
  else{if(!secrets.password)throw fail(400,'Enter an SSH password');secrets.private_key='';secrets.passphrase='';}
  r.jump_id=data.jump_id===undefined?(old?.jump_id||null):(data.jump_id||null);
  if(r.jump_id&&kind!=='owner')throw fail(403,'Shared jump hosts are managed by the account owner');
  if(r.jump_id&&(old?.tailnet_device_id||network?.device))throw fail(400,'Choose a jump host or a Tailscale device');
  chain(r);
  const changed=!old||['host','port','username','auth_type','fingerprint','private_key','passphrase','password','jump_id'].some(k=>data[k]!==undefined&&data[k]!==old[k]);
  db.prepare(`INSERT INTO ${table(kind)} (id,company_id,project_id,label,host,port,username,auth_type,fingerprint,encrypted,allow_agent,created_at,updated_at,tested_at,tailnet_account,tailnet_device_id,jump_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,host=excluded.host,port=excluded.port,username=excluded.username,auth_type=excluded.auth_type,fingerprint=excluded.fingerprint,encrypted=excluded.encrypted,allow_agent=excluded.allow_agent,updated_at=excluded.updated_at,tested_at=excluded.tested_at,jump_id=excluded.jump_id`).run(r.id,r.company_id,r.project_id,r.label.trim(),r.host,r.port,r.username,r.auth_type,r.fingerprint,encrypt(r,secrets),data.allow_agent===undefined?(old?.allow_agent||0):Number(data.allow_agent),old?.created_at||Date.now(),Math.max(Date.now(),(old?.updated_at||0)+1),changed?null:old.tested_at,old?.tailnet_account||network?.account||null,old?.tailnet_device_id||network?.device||null,r.jump_id);
  return list(kind,id).find(x=>x.id===r.id);
 }
 const hierarchy=require('./hierarchy').createHierarchy(db);
 function inherited(kind,id){
  if(kind==='owner')return[];
  const companyId=kind==='projects'?hierarchy.scope(Number(id))?.company_id:null;
  return [...list('owner',0),...(companyId!=null?list('companies',companyId):[])];
 }
 function context(projectId,actor=namespace){
  const connections=visible([...list('projects',projectId),...inherited('projects',projectId)],actor).map(c=>({id:c.id,label:c.label,host:c.host,port:c.port,username:c.username,source:c.project_id!=null?'project':c.company_id!=null?'company':'account',allow_agent:!!c.allow_agent,has_fingerprint:!!c.fingerprint,tested_at:c.tested_at,jump_id:c.jump_id}));
  return {saved:connections.length>0,status:connections.some(c=>c.allow_agent)?'ready':connections.length?'paused':'not_connected',connections,note:'Account SSH connections are inherited by every company and project in this workspace. Saved configuration is not a live network check. Work mode can use enabled connections; Ask and Plan can describe them but cannot connect. Do not request keys again for saved connections.'};
 }
 function agentList(projectId,actor=namespace){const current=hierarchy.scope(projectId);if(!current)return[];return visible(db.prepare(`SELECT ${columns} FROM ${all} WHERE allow_agent=1 AND (project_id=? OR company_id=? OR (company_id IS NULL AND project_id IS NULL)) ORDER BY label,id`).all(projectId,current.company_id??null),actor).map(c=>({...c,source:c.project_id!=null?'project':c.company_id!=null?'company':'account'}));}
 function forJob(projectId,companyId,id,actor=namespace){requireAccess(id,actor);const current=hierarchy.scope(projectId);if(!current||current.company_id!==companyId)throw fail(403,'Project company changed; start a fresh Work run');const r=db.prepare(`SELECT * FROM ${all} WHERE id=? AND allow_agent=1 AND (project_id=? OR company_id=? OR (company_id IS NULL AND project_id IS NULL))`).get(id,projectId,companyId);if(!r)throw fail(403,'SSH is not enabled for this project');chain(r,true);return {...r,...decrypt(r),encrypted:undefined};}
 const router=express.Router();router.use(express.json({limit:'100kb'}));
 router.use((req,res,next)=>{if(/^\/api\/account\/ssh(?:\/|$)/.test(req.path)){if(!req.workspaceIsOwner)return res.status(403).json({error:'Only the account owner can manage shared SSH connections'});req.url=req.url.replace('/api/account/ssh','/api/owner/0/ssh');}else if(/^\/api\/owner(?:\/|$)/.test(req.path))return res.status(404).json({error:'Not found'});next();});
 router.get('/api/:kind(companies|projects|owner)/:id/ssh',(req,res)=>{scope(req.params.kind,req.params.id);res.json({connections:visible(list(req.params.kind,req.params.id),req.cloudUserId),inherited:visible(inherited(req.params.kind,req.params.id),req.cloudUserId),can_manage_account:!!req.workspaceIsOwner,...(req.workspaceIsOwner?{members:members().map(({id,email,name,status})=>({id,email,name,status}))}:{})});});
 router.post('/api/:kind(companies|projects|owner)/:id/ssh',async(req,res,next)=>{try{let network;if(req.body.tailnet_device_id){if(!tailnet)throw fail(503,'Tailscale is not configured');const peer=await tailnet.device(req.cloudUserId,req.body.tailnet_device_id);network={account:req.cloudUserId,device:peer.id};req.body.host=peer.dns_name||peer.addresses[0];}req.revalidateMember?.();res.status(201).json(save(req.params.kind,req.params.id,req.body,undefined,network));}catch(e){next(e);}});
 router.patch('/api/:kind(companies|projects|owner)/:id/ssh/:connectionId',(req,res)=>{requireAccess(req.params.connectionId,req.cloudUserId);res.json(req.body.access!==undefined&&Object.keys(req.body).length===1?setAccess(req.params.kind,req.params.id,req.params.connectionId,req.body.access,req.cloudUserId):save(req.params.kind,req.params.id,req.body,req.params.connectionId));});
 router.delete('/api/:kind(companies|projects|owner)/:id/ssh/:connectionId',(req,res)=>{requireAccess(req.params.connectionId,req.cloudUserId);const r=row(req.params.kind,req.params.id,req.params.connectionId);db.transaction(()=>{db.prepare(`DELETE FROM ${table(req.params.kind)} WHERE id=?`).run(r.id);db.prepare('DELETE FROM ssh_access WHERE connection_id=?').run(r.id);})();res.json({ok:true});});
 router.post('/api/:kind(companies|projects|owner)/:id/ssh/:connectionId/test',async(req,res,next)=>{try{
  const resolve=()=>{requireAccess(req.params.connectionId,req.cloudUserId);scope(req.params.kind,req.params.id);const shared=inherited(req.params.kind,req.params.id).find(c=>c.id===req.params.connectionId);return shared?row(shared.company_id==null?'owner':'companies',shared.company_id||0,shared.id):row(req.params.kind,req.params.id,req.params.connectionId);};
  const r=resolve(),valid=()=>{try{req.revalidateMember?.();return resolve().updated_at===r.updated_at;}catch{return false;}};
  const result=await execute({...r,...decrypt(r)},{valid});if(!valid())throw fail(403,'SSH permission was removed');
  db.prepare(`UPDATE ${r.company_id==null&&r.project_id==null?'owner_ssh_connections':'ssh_connections'} SET tested_at=? WHERE id=? AND updated_at=?`).run(Date.now(),r.id,r.updated_at);res.json(result);
 }catch(e){next(e);}});
 router.use((e,req,res,next)=>e.status?res.status(e.status).json({error:e.message}):next(e));
 return{router,agentList,forJob,save,list,context,execute,redact:input=>{let text=input;for(const r of db.prepare(`SELECT * FROM ${all}`).all())text=redact(text,decrypt(r));return text;}};
}
module.exports={createSshConnections,connectSSH};
