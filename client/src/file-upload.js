// Each request is small; the server keeps the durable offset and acknowledges
// retries, so a network failure never requires restarting a large file.
export async function uploadFile({file,boardId,folderId=null,cardId=null,kind='project',workspaceId='',request,onProgress=()=>{},signal}){
 const base=`/api/boards/${boardId}/uploads`,key='boardly-file-upload:'+JSON.stringify([workspaceId,boardId,folderId,cardId,kind,file.name,file.size,file.lastModified]);
 let id;try{id=localStorage.getItem(key);}catch{}id||=crypto.randomUUID();
 const remember=()=>{try{localStorage.setItem(key,id);}catch{}};remember();
 const pause=ms=>new Promise((resolve,reject)=>{if(signal?.aborted)return reject(new DOMException('Upload paused','AbortError'));const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',stop);resolve();}function stop(){clearTimeout(timer);signal.removeEventListener('abort',stop);reject(new DOMException('Upload paused','AbortError'));}signal?.addEventListener('abort',stop,{once:true});});
 const retry=async fn=>{for(let n=0;;n++){try{return await fn();}catch(e){if(signal?.aborted||e.name==='AbortError'||n===4||(e.status&&e.status<500&&!/still being finalized/.test(e.message)))throw e;onProgress({name:file.name,loaded:offset,total:file.size,retrying:true});await pause(Math.min(4000,500*(n+1)));}}};
 let offset=0;
 const start=()=>request(base,{upload_id:id,name:file.name,size:file.size,mime:file.type||'application/octet-stream',folder_id:folderId,card_id:cardId,kind},signal);
 let state;try{state=await retry(start);}catch(e){if(e.status!==404)throw e;id=crypto.randomUUID();remember();state=await retry(start);}
 offset=state.offset;onProgress({name:file.name,loaded:offset,total:file.size});
 while(offset<file.size){const end=Math.min(offset+state.chunk_size,file.size),chunk=file.slice(offset,end);state=await retry(()=>request(`${base}/${id}/chunks?offset=${offset}`,chunk,signal));offset=state.offset;onProgress({name:file.name,loaded:offset,total:file.size});}
 onProgress({name:file.name,loaded:offset,total:file.size,finalizing:true});
 const result=await retry(()=>request(`${base}/${id}/complete`,{},signal));try{localStorage.removeItem(key);}catch{}return result;
}
