const http=require('node:http');
function request(action,data){
 const socketPath=process.env.BOARDLY_EMAIL_SOCKET;if(!socketPath)throw Error('Company email is not enabled for this project run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/'+action,method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.setEncoding('utf8');res.on('data',s=>{raw+=s;if(raw.length>200000)req.destroy();});
   res.on('end',()=>{try{const result=JSON.parse(raw);res.statusCode===200?resolve(result):reject(Error(result.error||'Email request failed'));}catch{reject(Error('Invalid company email response'));}});
  });req.on('error',()=>reject(Error('Company email connection unavailable')));req.setTimeout(35000,()=>req.destroy());req.end(JSON.stringify(data));
 });
}
const listMessages=({mailbox_id})=>request('list',{mailbox_id});
const readMessage=({mailbox_id,uid,uid_validity})=>request('read',{mailbox_id,uid,uid_validity});
// The code stays in this callback. Return metadata only, never the callback result.
async function withVerificationCode(query,fill){
 const result=await request('code',query);
 try{await fill(result.code);}catch{throw Error('Could not fill the verification field. Check the sign-in page before retrying.');}finally{result.code='';}
 return{uid:result.uid,uid_validity:result.uid_validity,received_at:result.received_at};
}
async function fillVerificationCode(page,query,{selector,origin}){
 const expected=new URL(origin);if(expected.protocol!=='https:')throw Error('Use the inspected HTTPS sign-in origin');
 const check=()=>{if(new URL(page.url()).origin!==expected.origin)throw Error('Sign-in page changed origin');};check();
 if(typeof selector!=='string'||!selector)throw Error('Provide the inspected verification-code input selector');
 return withVerificationCode(query,async code=>{check();await page.locator(selector).fill(code);check();});
}
module.exports={listMessages,readMessage,withVerificationCode,fillVerificationCode};
