const crypto=require('node:crypto'),express=require('express');
const {redact}=require('./project-environment');
const {safeText}=require('./agent-activity');
const fail=(status,message)=>Object.assign(Error(message),{status});
function connectSSH(config,{command,valid=()=>true,timeout=30000}={}){
 return new Promise((resolve,reject)=>{
  const {Client}=require('ssh2'),client=new Client();let ended=false,stdout='',stderr='',truncated=false;
  const finish=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);clearInterval(check);client.end();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>finish(fail(504,'SSH timed out. A remote command may still be running; inspect before retrying.')),Math.min(timeout,45000));
  const check=setInterval(()=>{if(!valid())finish(fail(403,'SSH permission or run access was removed'));},1000);
  client.on('error',()=>finish(fail(502,'SSH connection failed. Check credentials, network access and the pinned host fingerprint.')));
  client.on('close',()=>{if(!ended)finish(fail(502,'SSH disconnected. Inspect the remote result before retrying.'));});
  client.on('ready',()=>{
   if(!valid())return finish(fail(403,'SSH permission was removed'));
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
function createSshConnections({db,key,namespace,connector=connectSSH,tailnet}){
 const execute=async(config,options)=>{if(config.tailnet_device_id){if(!tailnet)throw fail(503,'Tailscale is not configured');const sock=await tailnet.dial(config.tailnet_account,config.tailnet_device_id,config.port);try{return await connector({...config,sock},options);}finally{sock.destroy();}}return connector(config,options);};
 db.exec(`CREATE TABLE IF NOT EXISTS ssh_connections (
 id TEXT PRIMARY KEY,company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
 project_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,label TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,
 username TEXT NOT NULL,auth_type TEXT NOT NULL,fingerprint TEXT NOT NULL,encrypted TEXT NOT NULL,
 allow_agent INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,tested_at INTEGER,
 CHECK((company_id IS NULL)!=(project_id IS NULL)));`);
 for(const column of ['tailnet_account','tailnet_device_id'])if(!db.prepare('PRAGMA table_info(ssh_connections)').all().some(c=>c.name===column))db.exec(`ALTER TABLE ssh_connections ADD COLUMN ${column} TEXT`);
 const columns='id,company_id,project_id,label,host,port,username,auth_type,fingerprint,allow_agent,created_at,updated_at,tested_at,tailnet_device_id';
 const aad=r=>Buffer.from(JSON.stringify(['ssh',namespace,r.id,r.company_id,r.project_id]));
 const decrypt=r=>{const b=Buffer.from(r.encrypted,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(aad(r));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());};
 const encrypt=(r,secrets)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad(r));const bytes=Buffer.concat([c.update(JSON.stringify(secrets)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64');};
 const field=kind=>kind==='companies'?'company_id':'project_id';
 function scope(kind,id){if(!db.prepare(`SELECT id FROM ${kind==='companies'?'companies':'boards'} WHERE id=?`).get(id))throw fail(404,'SSH scope not found');}
 const list=(kind,id)=>db.prepare(`SELECT ${columns} FROM ssh_connections WHERE ${field(kind)}=? ORDER BY label,id`).all(id);
 const row=(kind,id,cid)=>{scope(kind,id);const r=db.prepare(`SELECT * FROM ssh_connections WHERE id=? AND ${field(kind)}=?`).get(cid,id);if(!r)throw fail(404,'SSH connection not found');return r;};
 function save(kind,id,data,cid,network){
  scope(kind,id);const old=cid?row(kind,id,cid):null,r={...old,...data,id:old?.id||crypto.randomUUID(),company_id:kind==='companies'?Number(id):null,project_id:kind==='projects'?Number(id):null};
  if(!old&&list(kind,id).length>=25)throw fail(400,'This scope can store up to 25 SSH connections');
  for(const name of ['label','host','username'])if(typeof r[name]!=='string'||!r[name].trim()||r[name].length>254||/[\s\x00-\x1f]/.test(name==='label'?'':r[name]))throw fail(400,`Enter a valid ${name}`);
  if(!/^[a-z0-9._:[\]-]+$/i.test(r.host))throw fail(400,'Enter an SSH hostname or IP address');
  r.port=Number(r.port??22);if(!Number.isInteger(r.port)||r.port<1||r.port>65535)throw fail(400,'Enter an SSH port from 1 to 65535');
  if(!['key','password'].includes(r.auth_type))throw fail(400,'Choose a private key or password');
  if(typeof r.fingerprint!=='string'||!/^SHA256:[a-zA-Z0-9+/]{43}$/.test(r.fingerprint))throw fail(400,'Enter the trusted server host fingerprint (SHA256:…)');
  if(data.allow_agent!==undefined&&typeof data.allow_agent!=='boolean')throw fail(400,'Agent access must be on or off');
  const previous=old?decrypt(old):{},secrets={};
  for(const name of ['private_key','passphrase','password']){secrets[name]=data[name]||previous[name]||'';if(typeof secrets[name]!=='string'||secrets[name].length>32000||secrets[name].includes('\0'))throw fail(400,'Invalid SSH credential');}
  if(r.auth_type==='key'){if(!secrets.private_key)throw fail(400,'Enter a private SSH key');const parsed=require('ssh2').utils.parseKey(secrets.private_key,secrets.passphrase||undefined);if(parsed instanceof Error)throw fail(400,'Private key or passphrase is invalid');secrets.password='';}
  else{if(!secrets.password)throw fail(400,'Enter an SSH password');secrets.private_key='';secrets.passphrase='';}
  const changed=!old||['host','port','username','auth_type','fingerprint','private_key','passphrase','password'].some(k=>data[k]!==undefined&&data[k]!==old[k]);
  db.prepare(`INSERT INTO ssh_connections (id,company_id,project_id,label,host,port,username,auth_type,fingerprint,encrypted,allow_agent,created_at,updated_at,tested_at,tailnet_account,tailnet_device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,host=excluded.host,port=excluded.port,username=excluded.username,auth_type=excluded.auth_type,fingerprint=excluded.fingerprint,encrypted=excluded.encrypted,allow_agent=excluded.allow_agent,updated_at=excluded.updated_at,tested_at=excluded.tested_at`).run(r.id,r.company_id,r.project_id,r.label.trim(),r.host,r.port,r.username,r.auth_type,r.fingerprint,encrypt(r,secrets),data.allow_agent===undefined?(old?.allow_agent||0):Number(data.allow_agent),old?.created_at||Date.now(),Date.now(),changed?null:old.tested_at,old?.tailnet_account||network?.account||null,old?.tailnet_device_id||network?.device||null);
  return list(kind,id).find(x=>x.id===r.id);
 }
 const hierarchy=require('./hierarchy').createHierarchy(db);
 function agentList(projectId){const company=hierarchy.scope(projectId)?.company_id;return db.prepare(`SELECT ${columns} FROM ssh_connections WHERE allow_agent=1 AND (project_id=? OR company_id=?) ORDER BY label,id`).all(projectId,company??null);}
 function forJob(projectId,companyId,id){const current=hierarchy.scope(projectId);if(!current||current.company_id!==companyId)throw fail(403,'Project company changed; start a fresh Work run');const r=db.prepare('SELECT * FROM ssh_connections WHERE id=? AND allow_agent=1 AND (project_id=? OR company_id=?)').get(id,projectId,companyId);if(!r)throw fail(403,'SSH is not enabled for this project');return {...r,...decrypt(r),encrypted:undefined};}
 const router=express.Router();router.use(express.json({limit:'100kb'}));
 router.get('/api/:kind(companies|projects)/:id/ssh',(req,res)=>{scope(req.params.kind,req.params.id);res.json({connections:list(req.params.kind,req.params.id),inherited:req.params.kind==='projects'?agentList(Number(req.params.id)).filter(c=>c.company_id!==null):[]});});
 router.post('/api/:kind(companies|projects)/:id/ssh',async(req,res,next)=>{try{let network;if(req.body.tailnet_device_id){if(!tailnet)throw fail(503,'Tailscale is not configured');const peer=await tailnet.device(req.cloudUserId,req.body.tailnet_device_id);network={account:req.cloudUserId,device:peer.id};req.body.host=peer.dns_name||peer.addresses[0];}req.revalidateMember?.();res.status(201).json(save(req.params.kind,req.params.id,req.body,undefined,network));}catch(e){next(e);}});
 router.patch('/api/:kind(companies|projects)/:id/ssh/:connectionId',(req,res)=>res.json(save(req.params.kind,req.params.id,req.body,req.params.connectionId)));
 router.delete('/api/:kind(companies|projects)/:id/ssh/:connectionId',(req,res)=>{const r=row(req.params.kind,req.params.id,req.params.connectionId);db.prepare('DELETE FROM ssh_connections WHERE id=?').run(r.id);res.json({ok:true});});
 router.post('/api/:kind(companies|projects)/:id/ssh/:connectionId/test',async(req,res,next)=>{try{const r=row(req.params.kind,req.params.id,req.params.connectionId),result=await execute({...r,...decrypt(r)},{valid:()=>{try{req.revalidateMember?.();return true;}catch{return false;}}});req.revalidateMember?.();db.prepare('UPDATE ssh_connections SET tested_at=? WHERE id=? AND updated_at=?').run(Date.now(),r.id,r.updated_at);res.json(result);}catch(e){next(e);}});
 router.use((e,req,res,next)=>e.status?res.status(e.status).json({error:e.message}):next(e));
 return{router,agentList,forJob,save,list,execute,redact:input=>{let text=input;for(const r of db.prepare('SELECT * FROM ssh_connections').all())text=redact(text,decrypt(r));return text;}};
}
module.exports={createSshConnections,connectSSH};
