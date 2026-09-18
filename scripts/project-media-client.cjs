const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
function request(command,data={}){
 const socketPath=process.env.BOARDLY_MEDIA_SOCKET;if(!socketPath)throw Error('Media generation is only available in an enabled Work run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/'+command,method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.on('data',b=>{raw+=b;if(raw.length>3000000)req.destroy();});res.on('end',()=>{try{const result=JSON.parse(raw);res.statusCode===200?resolve(result):reject(Error(result.error||'Media operation failed'));}catch{reject(Error('Invalid media response'));}});
  });req.on('error',()=>reject(Error('Media operation interrupted; check the saved job before resubmitting')));req.setTimeout(110000,()=>req.destroy());req.end(JSON.stringify(data));
 });
}
module.exports={list:()=>request('list'),generate:data=>request('generate',data),status:data=>request('status',data),cancel:data=>request('cancel',data)};
