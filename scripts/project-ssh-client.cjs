const http=require('node:http');
function exec({connection_id,command}){
 const socketPath=process.env.BOARDLY_SSH_SOCKET;if(!socketPath)throw Error('SSH is only available in an authorized Work run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/exec',method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.on('data',b=>{raw+=b;if(raw.length>250000)req.destroy();});res.on('end',()=>{try{const d=JSON.parse(raw);res.statusCode===200?resolve(d):reject(Error(d.error||'SSH failed'));}catch{reject(Error('Invalid SSH response'));}});
  });req.on('error',()=>reject(Error('SSH broker unavailable')));req.setTimeout(50000,()=>req.destroy());req.end(JSON.stringify({connection_id,command}));
 });
}
module.exports={exec};
