const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {fixture}=require('./member-fixture');
async function viewerFixture({direct=false}={}){
 const secret='ab'.repeat(32),token='cu_viewer_fixture_account_key_123456',desktop_id=crypto.randomUUID(),calls=[],inputs=new Map();
 const desktop={id:desktop_id,kind:'pilot',state:'active',available:true,memory_mib:6144,vcpus:4,disk_gib:80,label:'ThinkCentre 8 GB'};
 let mode='agent',holder=null,epoch=0,frame='data:image/jpeg;base64,/9j/2Q==',screenGate=null;
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const error=()=>{throw Object.assign(Error('Human control is active. Agent screenshots and input are paused until explicit handback.'),{status:409});};
 const f=await fixture({computeruseOrigin:'https://computeruse.example',computeruseViewerKey:secret,computeruseRequest:async()=>({id:'cu-account',rentals:[],desktops:[desktop]}),computeruseDesktopRequest:async(_origin,key,command,data,headers={})=>{
  assert.equal(key,token);let viewer=null;
  if(headers['X-ComputerUse-Viewer']){
   const [payload,sig]=headers['X-ComputerUse-Viewer'].split('.');assert.equal(sig,crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(payload).digest('hex'));
   const c=JSON.parse(Buffer.from(payload,'base64url'));assert.equal(c.command,command);assert.equal(c.desktop_id,data.desktop_id);assert.equal(c.body_sha256,hash(JSON.stringify(data)));assert.equal(c.token_sha256,hash(token));assert.ok(c.exp>Math.floor(Date.now()/1000));viewer=c.viewer_id;
  }
  calls.push({command,viewer:!!viewer,desktop_id:data.desktop_id});
  if(command==='status')return{desktop,mode,can_control:mode==='human'&&viewer===holder,width:1280,height:800,direct_available:direct,epoch};
  if(command.startsWith('direct-')){assert.ok(viewer);if(mode==='human'&&holder!==viewer)error();if(!data.read_only&&mode!=='human')error();return {stream_id:data.stream_id||crypto.randomUUID(),sdp:JSON.stringify({read_only:data.read_only}),protocol:2,read_only:data.read_only,ttl:10};}
  if(command==='takeover'||command==='resume'){assert.ok(viewer);if(mode==='human'&&holder!==viewer)error();mode=command==='takeover'?'human':'agent';holder=mode==='human'?viewer:null;epoch++;return{mode,agents_paused:mode==='human'};}
  if(mode==='human'&&viewer!==holder)error();
  if(command==='screenshot'){if(screenGate){const gate=screenGate;screenGate=null;await gate();}return{image_url:frame};}
  if(command==='lease')return{lease:'fixture-private-lease',expires:Math.floor(Date.now()/1000)+60};
  if(command==='release')return{released:true};
  if(command==='action'){if(viewer&&mode!=='human')error();if(!inputs.has(data.operation_id))inputs.set(data.operation_id,data.action);return{state:'completed',operation_id:data.operation_id};}
  throw Error('Unexpected fixture command');
 }});
 const p=await f.project('Live computer company','Permit portal project');
 await f.api('/api/account/computeruse',{method:'PUT',body:{token}});
 await f.api(`/api/projects/${p.project.id}/computeruse`,{method:'PUT',body:{rental_ids:['desktop:'+desktop_id],allow_agent:true,allow_control:true}});
 const worker=await f.api('/api/connections',{method:'POST',body:{name:'Cloud agent viewer fixture',scope:'worker'}});
 async function workerApi(route,body){const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+worker.token,'content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;}
 async function start(){const thread=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});const job=await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Open the permit portal then let me take over.'}});assert.equal((await workerApi('/api/worker/claim',{cloud:true})).job.id,job.id);await workerApi(`/api/worker/jobs/${job.id}/computeruse/status`,{desktop_id});return{thread,job};}
 return{f,p,desktop_id,desktop,calls,inputs,token,secret,worker,workerApi,start,base:`/api/projects/${p.project.id}/computeruse/view/${desktop_id}`,setFrame:value=>frame=value,holdScreen:fn=>screenGate=fn,getMode:()=>mode};
}
module.exports={viewerFixture};
