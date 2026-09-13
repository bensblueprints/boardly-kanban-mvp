const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {StringDecoder}=require('node:string_decoder');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function inspectOutput(handle,secrets={}){
 const before=await handle.stat();if(!before.isFile())throw Error('Only regular output files can be uploaded');
 const hash=crypto.createHash('sha256'),needles=Object.values(secrets).filter(v=>typeof v==='string'&&v.length>=4).map(v=>Buffer.from(v));
 const overlap=Math.max(2048,...needles.map(v=>v.length)),buffer=Buffer.alloc(1024*1024);let offset=0,tail=Buffer.alloc(0),text=null;
 const decoder=new StringDecoder('utf8');let textTail='';
 while(offset<before.size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!bytesRead)throw Error('Output changed while checking it');const bytes=buffer.subarray(0,bytesRead);hash.update(bytes);
  if(text===null){const sample=bytes.subarray(0,4096);text=!sample.includes(0);if(text)try{new TextDecoder('utf-8',{fatal:true}).decode(sample,{stream:true});}catch{text=false;}}
  const window=Buffer.concat([tail,bytes]);if(needles.some(value=>window.includes(value)))throw Error('This output contains a private project value. Remove it before saving the file.');tail=Buffer.from(window.subarray(-overlap));
  // Log redaction (including card-number heuristics) must never inspect binary
  // archives/media as text. Check recognizable credentials only in text files.
  if(text){const value=textTail+decoder.write(bytes);if(/\b(?:bdly_|sk-(?:proj-)?)[A-Za-z0-9_-]{20,}|\bBearer\s+(?:eyJ|bdly_|sk-)[A-Za-z0-9_.-]{20,}/.test(value))throw Error('This text output contains a credential. Remove it before saving the file.');textTail=value.slice(-2048);}
  offset+=bytesRead;
 }
 const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('Output changed while checking it');
 return{size:before.size,sha256:hash.digest('hex'),mtimeMs:before.mtimeMs};
}
function createOutputUploader({outputDir,jobId,api,request,secrets={},stopped=()=>false,onProgress=()=>{}}){
 const pending=new Map();
 async function upload(name){
  if(typeof name!=='string'||name!==path.basename(name)||!name||name.length>250)throw Error('Choose a filename inside this run’s output folder');
  if(pending.has(name))return pending.get(name);
  const promise=save(name);pending.set(name,promise);try{return await promise;}finally{pending.delete(name);}
 }
 async function save(name){
  const handle=await fs.promises.open(path.join(outputDir,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   onProgress(name,'Checking output');const file=await inspectOutput(handle,secrets),uuid=crypto.createHash('sha256').update(jobId+'\0'+name+'\0'+file.sha256).digest('hex').slice(0,32),uploadId=uuid.slice(0,8)+'-'+uuid.slice(8,12)+'-'+uuid.slice(12,16)+'-'+uuid.slice(16,20)+'-'+uuid.slice(20);
   const base=`/api/worker/jobs/${jobId}/uploads`;let state;
   const retry=async fn=>{for(let n=0;;n++){if(stopped())throw Error('Upload paused with the worker');try{return await fn();}catch(e){if(n===4||(e.status&&e.status<500&&!/still being finalized/.test(e.message)))throw e;onProgress(name,'Reconnecting upload');await delay(Math.min(4000,500*(n+1)));}}};
   state=await retry(()=>api(base,{upload_id:uploadId,name,size:file.size,sha256:file.sha256,mime:'application/octet-stream'}));
   let offset=state.offset;const buffer=Buffer.alloc(state.chunk_size);
   while(offset<file.size){const size=Math.min(buffer.length,file.size-offset),{bytesRead}=await handle.read(buffer,0,size,offset);if(bytesRead!==size)throw Error('Output changed while uploading');const bytes=buffer.subarray(0,size);state=await retry(async()=>{const r=await request(`${base}/${uploadId}/chunks?offset=${offset}`,bytes);return r.json();});offset=state.offset;onProgress(name,`Uploading ${Math.round(100*offset/(file.size||1))}%`);}
   const after=await handle.stat();if(after.size!==file.size||after.mtimeMs!==file.mtimeMs)throw Error('Output changed while uploading');
   onProgress(name,'Finishing upload');const result=await retry(()=>api(`${base}/${uploadId}/complete`));onProgress(name,'Saved file to project');return{id:result.id,name:result.name,size:result.size,sha256:file.sha256};
  }finally{await handle.close();}
 }
 return{upload,async close(){await Promise.allSettled(pending.values());}};
}
async function createOutputBroker({socketPath,uploader}){
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');try{if(req.method!=='POST'||req.url!=='/upload')throw Error('Unknown file operation');let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2000)throw Error('Invalid file request');}res.end(JSON.stringify(await uploader.upload(JSON.parse(raw).name)));}
  catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
 return{async close(){await uploader.close();await new Promise(r=>server.close(r));fs.rmSync(socketPath,{force:true});}};
}
module.exports={inspectOutput,createOutputUploader,createOutputBroker};
