const http=require('node:http');
function upload({name}){
 const socketPath=process.env.BOARDLY_FILES_SOCKET;
 if(!socketPath)throw Error('File uploads are only available inside a Boardly Work run');
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:'/upload',method:'POST',headers:{'content-type':'application/json'}},res=>{
   let raw='';res.on('data',b=>raw+=b);
   res.on('end',()=>{
    try{const result=JSON.parse(raw);res.statusCode===200?resolve(result):reject(Error(result.error||'File upload failed'));}
    catch{reject(Error('Invalid upload response'));}
   });
  });
  req.on('error',()=>reject(Error('Upload connection interrupted. Retry the same filename to resume.')));
  req.end(JSON.stringify({name}));
 });
}
module.exports={upload};
