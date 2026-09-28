const http=require('node:http');
function request(action,{connection_id,...data}){
 const socketPath=process.env.BOARDLY_GITHUB_SOCKET;if(!socketPath)return Promise.reject(Error('No GitHub connection is enabled for this Work run'));
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/github',method:'POST',headers:{'content-type':'application/json'}},res=>{let body='';res.on('data',b=>{body+=b;if(body.length>16*1024*1024)req.destroy(Error('GitHub result is too large'));});res.on('error',reject);res.on('end',()=>{try{const result=JSON.parse(body);if(res.statusCode>=400)return reject(Object.assign(Error(result.error||'GitHub request failed'),{status:res.statusCode}));resolve(result);}catch(e){reject(e);}});});
  req.on('error',reject);req.setTimeout(180000,()=>req.destroy(Error('GitHub request timed out. Inspect its outcome before retrying.')));req.end(JSON.stringify({connection_id,action,data}));
 });
}
module.exports={status:data=>request('status',data),listFiles:data=>request('list',data),readFile:data=>request('read',data),commitFiles:data=>request('commit',data),verifyDeployment:data=>request('verify-deployment',data),deploy:data=>request('deploy',data)};
