const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
function request(command,data={}){
 const socketPath=process.env.BOARDLY_COMPUTER_SOCKET;if(!socketPath)throw Error('ComputerUse is only available in an enabled Work run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/'+command,method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.on('data',b=>{raw+=b;if(raw.length>3000000)req.destroy();});res.on('end',()=>{try{const result=JSON.parse(raw);res.statusCode===200?resolve(result):reject(Error(result.error||'Computer operation failed'));}catch{reject(Error('Invalid computer response'));}});
  });req.on('error',()=>reject(Error('Computer operation interrupted; observe before retrying input')));req.setTimeout(110000,()=>req.destroy());req.end(JSON.stringify(data));
 });
}
async function screenshot({desktop_id}){
 const r=await request('screenshot',{desktop_id}),directory=process.env.BOARDLY_COMPUTER_FRAMES;
 if(!directory||typeof r.image_url!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(r.image_url))throw Error('Invalid desktop image');
 const raw=Buffer.from(r.image_url.split(',')[1],'base64');if(raw.length>2000000||raw[0]!==255||raw[1]!==216)throw Error('Invalid desktop image');
 const file=path.join(directory,crypto.randomUUID()+'.jpg');fs.writeFileSync(file,raw,{mode:0o600,flag:'wx'});return {path:file,desktop_id};
}
module.exports={list:()=>request('list'),status:data=>request('status',data),screenshot,action:({desktop_id,action,operation_id=crypto.randomUUID()})=>request('action',{desktop_id,action,operation_id}),release:data=>request('release',data)};
