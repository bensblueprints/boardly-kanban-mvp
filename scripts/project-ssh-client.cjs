const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function request(action,data){
 const socketPath=process.env.BOARDLY_SSH_SOCKET;if(!socketPath)throw Error('SSH is only available in an authorized Work run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/'+action,method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.on('data',b=>{raw+=b;if(raw.length>(action==='inspect-image'?7500000:250000))req.destroy(Error('SSH response too large'));});res.on('error',()=>reject(Error('SSH response interrupted')));res.on('end',()=>{try{const d=JSON.parse(raw);res.statusCode===200?resolve(d):reject(Error(d.error||'SSH failed'));}catch{reject(Error('Invalid SSH response'));}});
  });req.on('error',()=>reject(Error('SSH broker unavailable')));req.setTimeout(action==='inspect-image'?310000:50000,()=>req.destroy());req.end(JSON.stringify(data));
 });
}
async function inspectImage({connection_id,path:remotePath,question}){
 const result=await request('inspect-image',{connection_id,path:remotePath,question});
 if(result.mode==='local'){
  if(typeof result.observation!=='string'||!result.observation.trim()||result.observation.length>1600||result.image_url||result.path)throw Error('Invalid local image observation');
  return{mode:'local',model:result.model,observation:result.observation,sha256:result.sha256,bytes:result.bytes,elapsed_ms:result.elapsed_ms};
 }
 const directory=process.env.BOARDLY_SSH_IMAGES,match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(result.image_url||'');
 if(!directory||result.mode!=='gpt'||!match)throw Error('SSH image inspection returned no supported image');
 const bytes=Buffer.from(match[2],'base64'),checked=require('../server/ssh-image').imageResult(bytes);
 if(checked.sha256!==result.sha256||bytes.length!==result.bytes)throw Error('SSH image integrity check failed');
 const imagePath=path.join(directory,crypto.randomUUID()+(match[1]==='png'?'.png':'.jpg'));
 fs.writeFileSync(imagePath,bytes,{mode:0o600,flag:'wx'});
 return{mode:'gpt',path:imagePath,sha256:checked.sha256,bytes:bytes.length};
}
module.exports={exec:({connection_id,command})=>request('exec',{connection_id,command}),inspectImage};
