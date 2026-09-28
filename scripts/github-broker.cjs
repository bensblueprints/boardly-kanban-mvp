const http=require('node:http'),fs=require('node:fs');
async function createGithubBroker({socketPath,request,onActivity=()=>{}}){
 let closed=false,count=0;const pending=new Set();
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  if(closed||req.method!=='POST'||req.url!=='/github'){res.writeHead(404);res.end('{}');return;}
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8*1024*1024)throw Error('Request too large');}
   const {connection_id,action,data={}}=JSON.parse(raw);
   if(typeof connection_id!=='string'||!['status','list','read','commit','verify-deployment','deploy'].includes(action))throw Error('Invalid GitHub request');
   const id='github:'+ ++count;onActivity(id,action==='deploy'?'Deploying verified GitHub commit':'GitHub · '+action,'running');
   const operation=request(connection_id,action,data);pending.add(operation);
   try{const result=await operation;onActivity(id,action==='commit'?'Changes pushed to GitHub':action==='deploy'?'GitHub release deployment checked':'GitHub · '+action,result.deployed===false?'failed':'completed');res.end(JSON.stringify(result));}
   finally{pending.delete(operation);}
  }catch(e){res.writeHead(e.status||502);res.end(JSON.stringify({error:e.message||'GitHub could not complete. Inspect the repository before retrying.'}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
 return{socketPath,async close(){closed=true;await Promise.allSettled(pending);await new Promise(r=>server.close(r));fs.rmSync(socketPath,{force:true});}};
}
module.exports={createGithubBroker};
