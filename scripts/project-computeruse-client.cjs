const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
function request(command,data={}){
 const socketPath=process.env.BOARDLY_COMPUTER_SOCKET;if(!socketPath)throw Error('ComputerUse is only available in an enabled Work run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/'+command,method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.on('data',b=>{raw+=b;if(raw.length>3000000)req.destroy();});res.on('end',()=>{try{const result=JSON.parse(raw);res.statusCode===200?resolve(result):reject(Error(result.error||'Computer operation failed'));}catch{reject(Error('Invalid computer response'));}});
  });req.on('error',()=>reject(Error('Computer operation interrupted; observe before retrying input')));req.setTimeout(110000,()=>req.destroy());req.end(JSON.stringify(data));
 });
}
async function observe(command,{desktop_id,question}){
 const r=await request(command,{desktop_id,question}),directory=process.env.BOARDLY_COMPUTER_FRAMES;
 if(r.mode==='local'){
  if(typeof r.observation!=='string'||r.observation.length>1600||r.image_url||r.path)throw Error('Invalid local screen observation');
  return r;
 }
 if(!directory||typeof r.image_url!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(r.image_url))throw Error('Invalid desktop image');
 const raw=Buffer.from(r.image_url.split(',')[1],'base64');if(raw.length>2000000||raw[0]!==255||raw[1]!==216)throw Error('Invalid desktop image');
 const file=path.join(directory,crypto.randomUUID()+'.jpg');fs.writeFileSync(file,raw,{mode:0o600,flag:'wx'});return {path:file,desktop_id};
}
// The screenshot command already accepts a focused question. Reuse it so active
// brokers from the previous release can adopt local vision without stopping work.
module.exports={logins:data=>request('logins',data),login:({desktop_id,login_id,mode,field,operation_id=crypto.randomUUID()})=>request('login',{desktop_id,login_id,mode,field,operation_id}),list:()=>request('list'),status:data=>request('status',data),screenshot:data=>observe('screenshot',data),inspect:data=>observe('screenshot',data),action:({desktop_id,action,operation_id=crypto.randomUUID()})=>request('action',{desktop_id,action,operation_id}),release:data=>request('release',data)};
