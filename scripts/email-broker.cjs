const http = require('node:http');
const fs = require('node:fs');
const { codes } = require('../server/company-email');
async function createEmailBroker({socketPath,request,onSecret=()=>{},onActivity=()=>{}}) {
  let count=0;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    req.setTimeout(35000,()=>req.destroy());
    if(req.method!=='POST'||!['/list','/read','/code'].includes(req.url)){res.writeHead(404);res.end('{"error":"Unknown email action"}');return;}
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8000)throw Error('Email request too large');}
      const result=await request(req.url.slice(1),JSON.parse(raw));
      if(result.code)onSecret(result.code);
      for(const code of codes(JSON.stringify(result)))onSecret(code);
      onActivity(`email:${++count}`,req.url==='/code'?'Retrieved company verification code':req.url==='/read'?'Read company email':'Checked company inbox');
      res.end(JSON.stringify(result));
    }catch(e){res.writeHead(e.status||502);res.end(JSON.stringify({error:e.status?e.message:'Company email request failed; check mailbox connection and agent access.'}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
  return{socketPath,async close(){await new Promise(r=>server.close(r));fs.rmSync(socketPath,{force:true});}};
}
module.exports={createEmailBroker};
