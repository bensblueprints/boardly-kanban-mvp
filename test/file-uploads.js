const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud'),Database=require('better-sqlite3');
(async()=>{const f=await fixture();let db;try{
 const a=await f.project('Files','Large files'),b=await f.project('Other','Private');const card=await f.api(`/api/lists/${a.list.id}/cards`,{method:'POST',body:{title:'Generated outputs'}});
 const viewer=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'reader@example.com',role:'viewer'}})).member.user_id,editor=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'editor@example.com',role:'editor'}})).member.user_id;
 const base=`/api/boards/${a.project.id}/uploads`,begin=body=>f.api(base,{method:'POST',body});
 const bytes=Buffer.concat([Buffer.from('PK\x03\x04\x00binary 4111111111111111'),crypto.randomBytes(6*1024*1024)]),hash=crypto.createHash('sha256').update(bytes).digest('hex'),args={upload_id:crypto.randomUUID(),name:'archive.zip',size:bytes.length,mime:'application/zip',card_id:card.id,sha256:hash};
 const start=await begin(args);assert.equal(start.offset,0);assert.equal((await begin(args)).upload_id,start.upload_id);
 const raw=async(id,offset,body,user='user_owner',boardId=a.project.id)=>fetch(f.base+`/api/boards/${boardId}/uploads/${id}/chunks?offset=${offset}`,{method:'POST',headers:{authorization:'Bearer '+f.token(user),'content-type':'application/octet-stream'},body});
 assert.equal((await raw(start.upload_id,0,bytes.subarray(0,100),viewer)).status,403);
 assert.equal((await raw(start.upload_id,0,bytes.subarray(0,100),editor)).status,404,'An editor cannot modify another actor’s transfer');
 assert.equal((await raw(start.upload_id,0,bytes.subarray(0,100),'user_owner',b.project.id)).status,404);
 assert.equal((await raw(start.upload_id,10,bytes.subarray(0,100))).status,409);
 const chunk=bytes.subarray(0,start.chunk_size);assert.equal((await raw(start.upload_id,0,chunk)).status,200);assert.equal((await raw(start.upload_id,0,chunk)).status,200,'Retry is idempotent');
 assert.equal((await raw(start.upload_id,0,Buffer.alloc(chunk.length))).status,409);
 assert.equal((await f.request(base+'/'+start.upload_id+'/complete',{method:'POST',body:{}})).status,409);
 assert.equal((await f.api(base+'/'+start.upload_id)).offset,chunk.length);
 assert.equal((await raw(start.upload_id,chunk.length,bytes.subarray(chunk.length))).status,200);
 const file=await f.api(base+'/'+start.upload_id+'/complete',{method:'POST',body:{}});assert.equal((await f.api(base+'/'+start.upload_id+'/complete',{method:'POST',body:{}})).id,file.id);assert.equal((await begin(args)).state,'complete');
 assert.deepEqual(Buffer.from(await(await f.request(`/api/project-files/${file.id}/download`,{user:viewer})).arrayBuffer()),bytes);assert.equal((await f.api(`/api/cards/${card.id}/files`)).files[0].id,file.id);
 await f.api(base+'/'+start.upload_id,{method:'DELETE'});assert.equal((await f.request(`/api/project-files/${file.id}/download`)).status,200,'Cancelling a completed transfer preserves the file');
 const small=await begin({name:'empty.custom-extension',size:0});assert.equal((await f.api(base+'/'+small.upload_id+'/complete',{method:'POST',body:{}})).size,0);
 const corrupt=await begin({name:'corrupt.bin',size:2,sha256:'0'.repeat(64)});await raw(corrupt.upload_id,0,Buffer.from('ok'));assert.equal((await f.request(base+'/'+corrupt.upload_id+'/complete',{method:'POST',body:{}})).status,422);await f.api(base+'/'+corrupt.upload_id,{method:'DELETE'});
 const attachment=await begin({name:'tool.installer',size:3,kind:'attachment',card_id:card.id});await raw(attachment.upload_id,0,Buffer.from('exe'));const attached=await f.api(base+'/'+attachment.upload_id+'/complete',{method:'POST',body:{}});assert.equal(attached.original_name,'tool.installer');assert.equal(await(await f.request(attached.url,{user:viewer})).text(),'exe');
 const e=await f.api(base,{user:editor,method:'POST',body:{name:'revoked.bin',size:2}});const grants=await f.api(`/api/projects/${a.project.id}/members`);await f.api('/api/memberships/'+grants.members.find(x=>x.email==='editor@example.com').grant_id,{method:'DELETE'});assert.equal((await raw(e.upload_id,0,Buffer.from('ok'),editor)).status,403);
 db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));const uploads=path.join(workspacePath(f.root,'user_owner'),'uploads'),service=require('../server/file-uploads').createFileUploads({db,uploadsDir:uploads}),used=require('../server/project-assets').storageUsage(db).usedBytes;
 service.cancel({boardId:a.project.id,actor:editor,limit:null},e.upload_id);
 const ctx={boardId:a.project.id,actor:'quota-fixture',limit:used+1024},reserved=service.begin(ctx,{name:'reserved',size:1024});assert.throws(()=>service.begin(ctx,{name:'excess',size:1}),/allowance/);service.cancel(ctx,reserved.upload_id);
 const stale=service.begin(ctx,{name:'stale',size:5});service.append(ctx,stale.upload_id,0,Buffer.from('hello'));db.prepare('UPDATE file_uploads SET updated_at=0 WHERE id=?').run(stale.upload_id);service.begin(ctx,{name:'after-expiry',size:1});assert.equal(fs.existsSync(path.join(uploads,'.partial',stale.upload_id)),false);
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
 // Exercise a real 110 MB transfer without buffering that file in the client.
 const size=110*1024*1024,big=await begin({name:'large-video.mp4',size}),block=Buffer.alloc(big.chunk_size,7),expected=crypto.createHash('sha256');
 for(let offset=0;offset<size;){const data=block.subarray(0,Math.min(block.length,size-offset));expected.update(data);const response=await raw(big.upload_id,offset,data);assert.equal(response.status,200,await response.clone().text());offset+=data.length;}
 const large=await f.api(base+'/'+big.upload_id+'/complete',{method:'POST',body:{}}),download=await f.request(`/api/project-files/${large.id}/download`),actual=crypto.createHash('sha256');let received=0;for await(const chunk of download.body){received+=chunk.length;actual.update(chunk);}assert.equal(received,size);assert.equal(actual.digest('hex'),expected.digest('hex'));
 console.log('PASS: 110 MB chunked upload/download, all file types, task links/attachments, zero bytes, checksum failures, durable offsets, idempotent retries/finalization, actor/project/member/revocation controls, concurrent quota reservations and expiry cleanup');
}finally{db?.close();await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
