const express=require('express'),crypto=require('node:crypto'),multer=require('multer');
const {createProvider,endpoint,relativePath,MAX_FILE}=require('./storage-provider');
const fail=(status,message)=>Object.assign(Error(message),{status});
function createCompanyStorage({db,key,namespace,transport}){
  db.exec(`CREATE TABLE IF NOT EXISTS company_storage(id TEXT PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,label TEXT NOT NULL,provider TEXT NOT NULL,config TEXT NOT NULL,encrypted TEXT NOT NULL,read_only INTEGER NOT NULL DEFAULT 1,revision TEXT NOT NULL,tested_at INTEGER,created_at INTEGER NOT NULL);`);
  const company=id=>{if(!db.prepare('SELECT id FROM companies WHERE id=?').get(id))throw fail(404,'Company not found.');};
  const row=(companyId,id)=>{const r=db.prepare('SELECT * FROM company_storage WHERE company_id=? AND id=?').get(companyId,id);if(!r)throw fail(404,'Storage connection not found in this company.');return r;};
  function crypt(value,id,companyId,decode=false){const aad=Buffer.from(JSON.stringify(['company-storage-v1',namespace,companyId,id]));if(decode){const b=Buffer.from(value,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(aad);c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]));}const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);const b=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');}
  const metadata=r=>({id:r.id,company_id:r.company_id,label:r.label,provider:r.provider,...JSON.parse(r.config),read_only:!!r.read_only,revision:r.revision,tested_at:r.tested_at,created_at:r.created_at});
  const list=companyId=>{company(companyId);return db.prepare('SELECT * FROM company_storage WHERE company_id=? ORDER BY label').all(companyId).map(metadata);};
  function clean(value,max,label,required=true){if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value)||required&&!value.trim())throw fail(400,`Enter a valid ${label}.`);return value.trim();}
  function config(data){
    if(!['s3','webdav'].includes(data.provider))throw fail(400,'Choose S3-compatible storage or WebDAV.');
    if(data.read_only!==undefined&&typeof data.read_only!=='boolean')throw fail(400,'Choose whether uploads are allowed.');
    const result={provider:data.provider,prefix:relativePath(data.prefix||'',true)};
    if(data.provider==='s3'){
      result.region=clean(data.region||'us-east-1',64,'region');if(!/^[a-z0-9-]+$/.test(result.region))throw fail(400,'Enter the region provided by your storage service.');
      result.bucket=clean(data.bucket,63,'bucket name');if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(result.bucket)||result.bucket.includes('..'))throw fail(400,'Enter a valid bucket name.');
      result.endpoint=endpoint(data.endpoint||`https://s3.${result.region}.amazonaws.com`).href.replace(/\/$/,'');
      if(new URL(result.endpoint).pathname!=='/')throw fail(400,'Use the S3 service address, without a bucket or folder path.');
    }else result.endpoint=endpoint(clean(data.endpoint,1000,'WebDAV address')).href;
    return result;
  }
  async function perform(r,action,valid=()=>{}){
    valid();const p=createProvider(JSON.parse(r.config),crypt(r.encrypted,r.id,r.company_id,true),transport);
    try{const result=await action(p);valid();if(row(r.company_id,r.id).revision!==r.revision)throw fail(409,'The storage connection changed. Reload and check the result before retrying.');return result;}
    catch(e){if(e.status)throw e;if(e.$metadata?.httpStatusCode===412)throw fail(409,'A file with that name already exists. Rename your upload.');throw fail(502,'The storage request did not finish. Check the address, keys and bucket permissions. For an upload, check the folder before trying again.');}
  }
  async function connect(companyId,data,valid=()=>{}){
    company(companyId);if(list(companyId).length>=20)throw fail(400,'A company can connect up to 20 storage services.');
    const cfg=config(data),id=crypto.randomUUID(),label=clean(data.label,100,'storage name');
    const secrets=cfg.provider==='s3'?{access_key:clean(data.access_key,256,'access key'),secret_key:clean(data.secret_key,2048,'secret key'),session_token:clean(data.session_token||'',8000,'session token',false)}:{username:clean(data.username,256,'username'),password:clean(data.password,2048,'app password')};
    valid();try{await createProvider(cfg,secrets,transport).list('');}catch(e){if(e.status)throw e;throw fail(400,'Could not open this storage folder. Check the address, credentials, bucket, region and read permissions.');}valid();company(companyId);
    if(list(companyId).length>=20)throw fail(409,'The connection list changed. Reload and try again.');
    db.prepare('INSERT INTO company_storage VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,companyId,label,cfg.provider,JSON.stringify(cfg),crypt(secrets,id,companyId),Number(data.read_only!==false),crypto.randomUUID(),Date.now(),Date.now());return metadata(row(companyId,id));
  }
  function update(companyId,id,data){const old=row(companyId,id);if(data.revision!==old.revision)throw fail(409,'The storage connection changed. Reload before saving.');if(Object.keys(data).some(k=>!['revision','label','read_only'].includes(k)))throw fail(400,'Only the storage name and upload permission can be edited. Reconnect to change provider credentials or folders.');if(data.read_only!==undefined&&typeof data.read_only!=='boolean')throw fail(400,'Choose whether uploads are allowed.');db.prepare('UPDATE company_storage SET label=?,read_only=?,revision=? WHERE id=?').run(data.label===undefined?old.label:clean(data.label,100,'storage name'),data.read_only===undefined?old.read_only:Number(data.read_only),crypto.randomUUID(),id);return metadata(row(companyId,id));}
  const router=express.Router(),base='/api/companies/:companyId/storage';
  router.use(base,express.json({limit:'32kb'}));
  const handle=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  router.get(base,(req,res)=>res.json({connections:list(Number(req.params.companyId)),max_file_bytes:MAX_FILE}));
  router.post(base,handle(async(req,res)=>res.status(201).json(await connect(Number(req.params.companyId),req.body,req.revalidateMember))));
  router.patch(base+'/:connectionId',(req,res)=>res.json(update(Number(req.params.companyId),req.params.connectionId,req.body)));
  router.post(base+'/:connectionId/test',handle(async(req,res)=>{const r=row(Number(req.params.companyId),req.params.connectionId);await perform(r,p=>p.list(''),req.revalidateMember);db.prepare('UPDATE company_storage SET tested_at=? WHERE id=?').run(Date.now(),r.id);res.json(metadata(row(r.company_id,r.id)));}));
  router.get(base+'/:connectionId/files',handle(async(req,res)=>{const r=row(Number(req.params.companyId),req.params.connectionId),path=relativePath(req.query.path||'',true),cursor=clean(req.query.cursor||'',4000,'page cursor',false);res.json(await perform(r,p=>p.list(path,cursor),req.revalidateMember));}));
  router.get(base+'/:connectionId/download',handle(async(req,res)=>{const r=row(Number(req.params.companyId),req.params.connectionId),path=relativePath(req.query.path||'');if(!path)throw fail(400,'Choose a file.');const file=await perform(r,p=>p.get(path),req.revalidateMember);res.set('Content-Security-Policy',"sandbox; default-src 'none'").set('Cache-Control','no-store').attachment(path.split('/').pop()).send(file.body);}));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_FILE,files:1,fields:2}}).single('file');
  router.post(base+'/:connectionId/files',(req,res,next)=>{try{const r=row(Number(req.params.companyId),req.params.connectionId);if(r.read_only)throw fail(403,'Uploads are disabled for this storage connection.');upload(req,res,next);}catch(e){next(e);}},handle(async(req,res)=>{
    const r=row(Number(req.params.companyId),req.params.connectionId);if(r.read_only)throw fail(403,'Uploads are disabled.');if(!req.file)throw fail(400,'Choose a file to upload.');const name=clean(req.file.originalname,250,'file name');if(name.includes('/')||name.includes('\\'))throw fail(400,'Use a file name without slashes.');const path=relativePath(req.body.path||'',true)+relativePath(name);
    await perform(r,p=>p.put(path,req.file.buffer,req.file.mimetype||'application/octet-stream'),req.revalidateMember);res.status(201).json({ok:true,path});
  }));
  router.delete(base+'/:connectionId',(req,res)=>{const r=row(Number(req.params.companyId),req.params.connectionId);if(req.body.revision!==r.revision)throw fail(409,'The connection changed. Reload before disconnecting.');db.prepare('DELETE FROM company_storage WHERE id=?').run(r.id);res.json({ok:true,files_preserved:true});});
  return {router,list,connect,update};
}
function companyResourceGuard({memberships}){
  return(req,res,next)=>{
    const match=req.path.match(/^\/api\/companies\/(\d+)\/(skills|storage)(?:\/(.*))?$/);if(!match)return next();
    const companyId=Number(match[1]),kind=match[2],suffix=match[3]||'',method=req.method==='HEAD'?'GET':req.method;
    const verify=()=>{if(req.workspaceIsOwner)return;const scope=require('./member-access').accessForMember(req.tenant.app.db,memberships.grants(req.workspaceOwnerId,req.cloudUserId));const role=scope.company(companyId);if(!role)throw fail(404,'Company not found.');const upload=kind==='storage'&&/^[a-f0-9-]+\/files$/.test(suffix)&&method==='POST';if(method!=='GET'&&!(upload&&role==='editor'))throw fail(403,'Only the account owner can change company rules, skills and storage connections.');};
    try{verify();req.revalidateMember=verify;req.tenant[kind==='skills'?'skills':'storage'].router(req,res,next);}catch(e){next(e);}
  };
}
module.exports={createCompanyStorage,companyResourceGuard};
