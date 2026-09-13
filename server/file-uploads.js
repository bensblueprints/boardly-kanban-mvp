const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
const CHUNK=4*1024*1024,TTL=7*86400000,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function installUploads(db){db.exec(`CREATE TABLE IF NOT EXISTS file_uploads (
 id TEXT PRIMARY KEY,board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
 actor TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,
 folder_id INTEGER REFERENCES project_folders(id) ON DELETE SET NULL,card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
 kind TEXT NOT NULL,job_id TEXT,sha256 TEXT,offset INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'open',updated_at INTEGER NOT NULL,
 file_id INTEGER REFERENCES project_files(id) ON DELETE SET NULL,attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL
 ); CREATE INDEX IF NOT EXISTS file_uploads_project ON file_uploads(board_id);`);}
function createFileUploads({db,uploadsDir}){
 installUploads(db);const partial=path.join(uploadsDir,'.partial');fs.mkdirSync(partial,{recursive:true,mode:0o700});
 const disk=id=>path.join(partial,id),destination=id=>path.join(uploadsDir,'project-'+id);
 const rows=()=>db.prepare("SELECT * FROM file_uploads WHERE state!='complete' AND updated_at>?").all(Date.now()-TTL);
 const usage=()=>require('./project-assets').storageUsage(db).usedBytes;
 const view=r=>({upload_id:r.id,offset:r.offset,size:r.size,chunk_size:CHUNK,state:r.state,file_id:r.file_id,attachment_id:r.attachment_id});
 function resource(ctx){ctx.valid?.();if(!db.prepare('SELECT 1 FROM boards WHERE id=?').get(ctx.boardId))throw fail(404,'Project not found');}
 function get(ctx,id){resource(ctx);if(!UUID.test(id||''))throw fail(404,'Upload not found');const r=db.prepare('SELECT * FROM file_uploads WHERE id=? AND board_id=? AND actor=?').get(id,ctx.boardId,ctx.actor);if(!r||(r.state!=='complete'&&r.updated_at<Date.now()-TTL)||(r.state==='complete'&&!r.file_id&&!r.attachment_id))throw fail(404,'Upload expired or not found');return r;}
 function task(boardId,id){if(id!=null&&!db.prepare('SELECT 1 FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=?').get(id,boardId))throw fail(404,'Task not found in this project');return id??null;}
 function quota(ctx,extra=0,except=null){const reserved=rows().filter(r=>r.id!==except).reduce((n,r)=>n+r.size,0);if(ctx.limit!=null&&usage()+reserved+extra>ctx.limit)throw fail(413,'Your storage allowance is full');}
 function prune(){
  for(const r of db.prepare("SELECT id FROM file_uploads WHERE state!='complete' AND updated_at<?").all(Date.now()-TTL)){fs.rmSync(disk(r.id),{force:true});db.prepare('DELETE FROM file_uploads WHERE id=?').run(r.id);}
  for(const name of fs.readdirSync(partial)){if(UUID.test(name)&&fs.statSync(disk(name)).mtimeMs<Date.now()-TTL&&!db.prepare('SELECT 1 FROM file_uploads WHERE id=?').get(name))fs.rmSync(disk(name),{force:true});}
 }
 function begin(ctx,args={}){
  resource(ctx);prune();const id=args.upload_id||crypto.randomUUID();if(!UUID.test(id))throw fail(400,'Invalid upload ID');
  const name=String(args.name||'');if(!name.trim()||name.length>250||/[\\/\x00-\x1f]/.test(name))throw fail(400,'Choose a valid filename');
  const size=args.size;if(!Number.isSafeInteger(size)||size<0)throw fail(400,'Choose a valid file size');
  const mime=typeof args.mime==='string'&&/^[\w.+-]+\/[\w.+-]+$/.test(args.mime)?args.mime:'application/octet-stream';
  const folder=require('./project-folders').folderId(db,ctx.boardId,args.folder_id),card=task(ctx.boardId,ctx.cardId??args.card_id),kind=args.kind==='attachment'?'attachment':'project';
  if(kind==='attachment'&&!card)throw fail(400,'Choose a task for this attachment');
  const hash=args.sha256??null;if(hash!==null&&!/^[a-f0-9]{64}$/.test(hash))throw fail(400,'Invalid file checksum');
  const prior=db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);
  if(prior){get(ctx,id);if(prior.name!==name||prior.size!==size||prior.mime!==mime||prior.card_id!==card||prior.folder_id!==folder||prior.sha256!==hash||prior.kind!==kind||prior.job_id!==(ctx.jobId??null))throw fail(409,'This upload ID belongs to a different file');return view(prior);}
  db.transaction(()=>{
   const saved=ctx.jobId&&hash?db.prepare('SELECT o.file_id FROM chat_outputs o JOIN project_files f ON f.id=o.file_id WHERE o.job_id=? AND o.name=? AND o.sha256=? AND f.board_id=?').get(ctx.jobId,name,hash,ctx.boardId):null;
   if(saved){db.prepare("INSERT INTO file_uploads(id,board_id,actor,name,mime,size,folder_id,card_id,kind,job_id,sha256,updated_at,offset,state,file_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'complete',?)").run(id,ctx.boardId,ctx.actor,name,mime,size,folder,card,kind,ctx.jobId,hash,Date.now(),size,saved.file_id);if(card)require('./task-files').linkTaskFile(db,card,saved.file_id,{generated:true});return;}
   quota(ctx,size);const stat=fs.statfsSync(uploadsDir),remaining=rows().reduce((n,r)=>n+r.size-r.offset,0);if(size+remaining>stat.bavail*stat.bsize)throw fail(507,'The server does not have enough available storage for this file');
   fs.closeSync(fs.openSync(disk(id),'wx',0o600));
   try{db.prepare('INSERT INTO file_uploads(id,board_id,actor,name,mime,size,folder_id,card_id,kind,job_id,sha256,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ctx.boardId,ctx.actor,name,mime,size,folder,card,kind,ctx.jobId??null,hash,Date.now());}catch(e){fs.rmSync(disk(id),{force:true});throw e;}
  }).immediate();return view(get(ctx,id));
 }
 function append(ctx,id,offset,bytes){return db.transaction(()=>{
  const r=get(ctx,id);if(r.state!=='open')throw fail(409,'Upload is being finalized or is already complete');
  if(!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>CHUNK||offset+bytes.length>r.size)throw fail(400,'Invalid upload chunk');
  if(offset>r.offset)throw fail(409,'Resume from the saved upload offset');
  if(offset<r.offset){if(offset+bytes.length>r.offset)throw fail(409,'Chunk overlaps the saved upload offset');const previous=Buffer.alloc(bytes.length),fd=fs.openSync(disk(id),'r');try{assertRead(fd,previous,offset);}finally{fs.closeSync(fd);}if(!previous.equals(bytes))throw fail(409,'Retried chunk contents differ');return view(r);}
  quota(ctx,r.size,id);const fd=fs.openSync(disk(id),'r+');try{fs.ftruncateSync(fd,r.offset);let written=0;while(written<bytes.length)written+=fs.writeSync(fd,bytes,written,bytes.length-written,offset+written);fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}
  db.prepare('UPDATE file_uploads SET offset=?,updated_at=? WHERE id=?').run(offset+bytes.length,Date.now(),id);return view(get(ctx,id));
 }).immediate();}
 function completed(r){const file=r.kind==='attachment'?db.prepare('SELECT *,original_name AS name FROM attachments WHERE id=?').get(r.attachment_id):db.prepare('SELECT * FROM project_files WHERE id=?').get(r.file_id);if(!file)throw fail(404,'The uploaded file was deleted');return{...file,...(r.kind==='attachment'?{url:'/uploads/'+file.filename}:{})};}
 async function finish(ctx,id){
  const r=db.transaction(()=>{const row=get(ctx,id);if(row.state==='complete')return row;
   if(row.offset!==row.size)throw fail(409,'The upload is not complete');
   if(row.state==='finishing'&&row.updated_at>Date.now()-300000)throw fail(409,'The file is still being finalized');
   db.prepare("UPDATE file_uploads SET state='finishing',updated_at=? WHERE id=?").run(Date.now(),id);return row;
  }).immediate();if(r.state==='complete')return completed(r);
  const timer=setInterval(()=>db.prepare('UPDATE file_uploads SET updated_at=? WHERE id=?').run(Date.now(),id),30000);timer.unref();
  try{
   const source=fs.existsSync(disk(id))?disk(id):destination(id);if(fs.statSync(source).size!==r.size)throw fail(409,'Saved upload size changed');
   const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(source))hash.update(chunk);const digest=hash.digest('hex');if(r.sha256&&r.sha256!==digest)throw fail(422,'File checksum does not match; start this upload again');
   resource(ctx);task(ctx.boardId,r.card_id);if(r.kind==='attachment'&&!r.card_id)throw fail(404,'The attachment task was deleted');
   db.transaction(()=>{
    quota(ctx,r.size,id);let fileId=null,attachmentId=null;
    if(r.job_id){const prior=db.prepare('SELECT file_id FROM chat_outputs WHERE job_id=? AND name=? AND sha256=?').get(r.job_id,r.name,digest);if(prior)fileId=prior.file_id;}
    if(!fileId){if(source!==destination(id))fs.renameSync(source,destination(id));
     if(r.kind==='attachment')attachmentId=Number(db.prepare('INSERT INTO attachments(card_id,filename,original_name,size,mime) VALUES(?,?,?,?,?)').run(r.card_id,'project-'+id,r.name,r.size,r.mime).lastInsertRowid);
     else fileId=Number(db.prepare('INSERT INTO project_files(uuid,board_id,name,filename,size,mime,created_at,folder_id) VALUES(?,?,?,?,?,?,?,?)').run(id,r.board_id,r.name,'project-'+id,r.size,r.mime,Date.now(),r.folder_id).lastInsertRowid);
     if(r.job_id)db.prepare('INSERT INTO chat_outputs(job_id,name,sha256,file_id) VALUES(?,?,?,?)').run(r.job_id,r.name,digest,fileId);
    }
    if(fileId&&r.card_id)require('./task-files').linkTaskFile(db,r.card_id,fileId,{generated:!!r.job_id});
    db.prepare("UPDATE file_uploads SET state='complete',file_id=?,attachment_id=?,updated_at=? WHERE id=?").run(fileId,attachmentId,Date.now(),id);
   })();fs.rmSync(disk(id),{force:true});return completed(get(ctx,id));
  }catch(e){db.prepare("UPDATE file_uploads SET state='open',updated_at=? WHERE id=? AND state='finishing'").run(Date.now(),id);throw e;}
  finally{clearInterval(timer);}
 }
 function cancel(ctx,id){const r=get(ctx,id);if(r.state==='finishing'&&r.updated_at>Date.now()-300000)throw fail(409,'The file is being finalized');if(r.state==='complete')return{ok:true};fs.rmSync(disk(id),{force:true});db.prepare('DELETE FROM file_uploads WHERE id=?').run(id);return{ok:true};}
 return{begin,status:(ctx,id)=>view(get(ctx,id)),append,finish,cancel};
}
function assertRead(fd,buffer,offset){let n=0;while(n<buffer.length){const read=fs.readSync(fd,buffer,n,buffer.length-n,offset+n);if(!read)throw fail(409,'Saved chunk is incomplete');n+=read;}}
function mountUploadRoutes(router,{base,service,guard=(q,s,n)=>n(),context}){
 const json=express.json({limit:'2mb'}),raw=express.raw({type:'application/octet-stream',limit:CHUNK});
 const handle=fn=>async(req,res,next)=>{try{res.set('Cache-Control','private, no-store').json(await fn(req,context(req)));}catch(e){if(e.code==='ENOSPC')e=fail(507,'The server storage is full');next(e);}};
 router.post(base,guard,json,handle((req,ctx)=>service.begin(ctx,req.body)));
 router.get(base+'/:uploadId',guard,handle((req,ctx)=>service.status(ctx,req.params.uploadId)));
 router.post(base+'/:uploadId/chunks',guard,raw,json,handle((req,ctx)=>{
  const binary=Buffer.isBuffer(req.body),offset=binary?Number(req.query.offset):req.body?.offset;let bytes=req.body;
  if(!binary){const value=req.body?.content_base64;if(typeof value!=='string'||value.length>1400000||!value.length||(value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)))throw fail(400,'Supply a base64 chunk of at most 1 MB');bytes=Buffer.from(value,'base64');}
  return service.append(ctx,req.params.uploadId,offset,bytes);
 }));
 router.post(base+'/:uploadId/complete',guard,handle((req,ctx)=>service.finish(ctx,req.params.uploadId)));
 router.delete(base+'/:uploadId',guard,handle((req,ctx)=>service.cancel(ctx,req.params.uploadId)));
}
module.exports={installUploads,createFileUploads,mountUploadRoutes,CHUNK};
