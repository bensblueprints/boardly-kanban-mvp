const assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express'),{Readable}=require('node:stream');
const {internalRequest}=require('../server/internal-request');
(async()=>{
 const app=express(),bytes=crypto.randomBytes(768*1024);
 app.get('/media',(req,res)=>{res.type('image/png');Readable.from([bytes.subarray(0,256*1024),bytes.subarray(256*1024)]).pipe(res);});
 app.get('/too-large',(req,res)=>{res.type('video/mp4');Readable.from([Buffer.alloc(5*1024*1024)]).pipe(res);});
 const result=await internalRequest(app,{method:'GET',url:'/media',headers:{},timeout:1500});
 assert.equal(result.status,200);assert.deepEqual(Buffer.from(result.data.content,'base64'),bytes);
 await assert.rejects(()=>internalRequest(app,{method:'GET',url:'/too-large',headers:{},timeout:1500}),e=>e.status===413);
 console.log('PASS: streamed management response survives backpressure with exact bytes; 4 MB response limit retained');
})().catch(e=>{console.error(e);process.exitCode=1;});
