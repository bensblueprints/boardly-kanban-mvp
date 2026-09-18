const http=require('node:http'),fs=require('node:fs');
const {connectSSH}=require('../server/ssh-connections');
async function createSshBroker({socketPath,request,execute,inspectImage,onSecret=()=>{},onActivity=()=>{}}){
 let closed=false,count=0;const pending=new Set();
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  const image=req.url==='/inspect-image';
  if(req.method!=='POST'||(!image&&req.url!=='/exec')){res.writeHead(404);res.end('{}');return;}
  try{let raw='';for await(const b of req){raw+=b;if(raw.length>40000)throw Error('Request too large');}
   const data=JSON.parse(raw);
   if(image){if(!inspectImage)throw Object.assign(Error('SSH image inspection is unavailable'),{status:503});if(typeof data.path!=='string'||!data.path.startsWith('/')||typeof data.question!=='string'||!data.question.trim()||data.question.length>1200)throw Object.assign(Error('Enter an absolute image path and a question up to 1200 characters'),{status:400});}
   else if(typeof data.command!=='string'||!data.command.trim()||data.command.length>30000)throw Error('Enter an SSH command');
   const config=await request(data.connection_id);
   for(const k of ['private_key','password','passphrase'])if(config[k])onSecret(config[k]);
   let authorized=true,checking=false;
   const timer=setInterval(async()=>{if(checking)return;checking=true;try{const current=await request(data.connection_id);authorized=current.updated_at===config.updated_at;}catch{authorized=false;}finally{checking=false;}},2000);
   const key=`ssh:${++count}`;onActivity(key,`SSH · ${config.label}`,'running');
   const operation=Promise.resolve().then(()=>image?inspectImage({connection_id:data.connection_id,path:data.path,question:data.question}):execute?execute({connection_id:data.connection_id,command:data.command}):connectSSH(config,{command:data.command,valid:()=>!closed&&authorized}));pending.add(operation);
   try{const result=await operation;if(image){const current=await request(data.connection_id);if(closed||!authorized||current.updated_at!==config.updated_at)throw Object.assign(Error('SSH permission changed during image inspection'),{status:403});}onActivity(key,`SSH · ${config.label}`,image||result.code===0?'completed':'failed');res.end(JSON.stringify(result));}
   catch(e){onActivity(key,`SSH · ${config.label}`,'failed');throw e;}
   finally{pending.delete(operation);clearInterval(timer);}
  }catch(e){res.writeHead(e.status||502);res.end(JSON.stringify({error:e.status?e.message:'SSH could not complete. Check the connection and remote result before retrying.'}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
 return{socketPath,async close(){closed=true;await Promise.allSettled(pending);await new Promise(r=>server.close(r));fs.rmSync(socketPath,{force:true});}};
}
module.exports={createSshBroker};
