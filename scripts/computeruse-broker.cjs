const http=require('node:http'),fs=require('node:fs');
async function createComputerUseBroker({socketPath,request,onActivity=()=>{}}){
 let count=0;const pending=new Set();
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  try{
   if(req.method!=='POST'||!['/list','/status','/screenshot','/action','/release','/logins','/login'].includes(req.url))throw Error('Unknown computer action');
   let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>25000)throw Error('Request too large');}
   const command=req.url.slice(1),key='computer:'+ ++count;onActivity(key,'Computer · '+command,'running');
   const call=request(command,JSON.parse(raw||'{}'));pending.add(call);
   try{const result=await call;onActivity(key,'Computer · '+command,'completed');res.end(JSON.stringify(result));}finally{pending.delete(call);}
  }catch(e){res.writeHead(e.status||502);res.end(JSON.stringify({error:e.status?e.message:'Computer operation could not complete. Inspect its status before retrying.'}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
 return{socketPath,async close(){await Promise.allSettled(pending);await new Promise(r=>server.close(r));try{await request('release-all',{});}catch{}fs.rmSync(socketPath,{force:true});}};
}
module.exports={createComputerUseBroker};
