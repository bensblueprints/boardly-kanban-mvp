const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
function androidDownload({directory}) {
 const router=express.Router();
 const release=()=>{
  try {
   const m=JSON.parse(fs.readFileSync(path.join(directory,'release.json'),'utf8'));
   if(!/^Boardly-[\d.]+\.apk$/.test(m.file)||!/^\d+\.\d+\.\d+$/.test(m.version)||!Number.isSafeInteger(m.version_code)||m.version_code<1||!/^[a-f0-9]{64}$/.test(m.sha256))throw Error('Invalid release');
   const file=path.join(directory,m.file),stat=fs.statSync(file);
   if(!stat.isFile()||stat.size!==m.size||m.size<1||m.size>300000000)throw Error('Invalid release');
   return {...m,file};
  } catch {throw Object.assign(Error('The Android download is being prepared. Please check back shortly.'),{status:503});}
 };
 // A paired owner device or an MCP connection does not authenticate a customer.
 router.use('/api/mobile/android',(req,res,next)=>req.boardlyConnection?res.status(403).json({error:'Sign in with your Boardly account to download the app.'}):next());
 router.get('/api/mobile/android/release',(req,res,next)=>{try{const r=release();res.json({version:r.version,version_code:r.version_code,sha256:r.sha256,size:r.size,download_url:'/api/mobile/android/apk'});}catch(e){next(e);}});
 router.get('/api/mobile/android/apk',(req,res,next)=>{try{const r=release();res.set('Cache-Control','private, no-store');res.download(r.file,path.basename(r.file),error=>{if(error&&!res.headersSent)next(error);});}catch(e){next(e);}});
 return router;
}
module.exports={androidDownload};
