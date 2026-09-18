const crypto=require('node:crypto'),http=require('node:http'),https=require('node:https'),express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
function createTailnet({url,token}={}){
 const configured=!!(url&&token);const account=user=>crypto.createHash('sha256').update(user).digest('hex');
 async function call(user,action,method='GET'){
  if(!configured)throw fail(503,'Tailscale cloud connections are not configured');
  let response;try{response=await fetch(`${url}/accounts/${account(user)}/${action}`,{method,headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});}catch{throw fail(503,'The Tailscale connector is temporarily unavailable');}
  const data=await response.json();if(!response.ok)throw fail(response.status,data.error||'Tailscale request failed');return data;
 }
 async function device(user,id){if(typeof id!=='string'||id.length>150)throw fail(400,'Choose a Tailscale device');const status=await call(user,'status');if(status.state!=='Running')throw fail(409,'Connect your Tailscale account first');const peer=status.devices.find(d=>d.id===id);if(!peer)throw fail(403,'Device is not in your Tailscale network');return peer;}
 async function dial(user,id,port){await device(user,id);return new Promise((resolve,reject)=>{
  const destination=new URL(`${url}/accounts/${account(user)}/dial`),client=destination.protocol==='https:'?https:http;
  const request=client.request(destination,{method:'CONNECT',headers:{authorization:'Bearer '+token,'x-boardly-device':id,'x-boardly-port':String(port)}});
  request.setTimeout(20000,()=>request.destroy(Error('Timeout')));request.once('error',()=>reject(fail(502,'The Tailscale device could not be reached')));
  request.once('connect',(response,socket,head)=>{if(response.statusCode!==200){socket.destroy();reject(fail(502,'Tailscale could not reach this device. Check its online status and network permissions.'));return;}socket.setTimeout(0);if(head.length)socket.unshift(head);resolve(socket);});request.end();
 });}
 const router=express.Router();router.use('/api/account/tailscale',express.json({limit:'10kb'}));
 router.get('/api/account/tailscale',async(req,res,next)=>{try{res.json(configured?{configured,...await call(req.cloudUserId,'status')}:{configured,state:'unavailable',devices:[]});}catch(e){next(e);}});
 router.post('/api/account/tailscale/connect',async(req,res,next)=>{try{res.json(await call(req.cloudUserId,'connect','POST'));}catch(e){next(e);}});
 router.post('/api/account/tailscale/disconnect',async(req,res,next)=>{try{res.json(await call(req.cloudUserId,'disconnect','POST'));}catch(e){next(e);}});
 return{router,device,dial,configured};
}
module.exports={createTailnet};
