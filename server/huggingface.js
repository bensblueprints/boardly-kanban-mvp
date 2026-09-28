const crypto=require('node:crypto'),express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
function createHuggingFace({db,key,namespace,request=fetch}){
 db.exec('CREATE TABLE IF NOT EXISTS huggingface_connection(id INTEGER PRIMARY KEY CHECK(id=1),encrypted TEXT NOT NULL,profile TEXT NOT NULL,revision TEXT NOT NULL)');
 const row=()=>db.prepare('SELECT * FROM huggingface_connection WHERE id=1').get();
 const aad=Buffer.from('huggingface:'+namespace);
 const seal=token=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);return Buffer.concat([iv,c.update(token),c.final(),c.getAuthTag()]).toString('base64');};
 const decode=r=>{const b=Buffer.from(r.encrypted,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(aad);c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();};
 const state=()=>{const r=row();return {connected:!!r,...(r?JSON.parse(r.profile):{username:'',organizations:[]})};};
 async function call(token,route){
  let response;try{response=await request('https://huggingface.co'+route,{headers:{Authorization:'Bearer '+token,Accept:'application/json','User-Agent':'Boardly/1.0'},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw fail(502,'Hugging Face could not be reached.');}
  if(!response.ok){await response.body?.cancel();throw fail([401,403].includes(response.status)?403:502,'Hugging Face rejected this request. Check your token and organization permissions.');}
  let size=0;const chunks=[];for await(const b of response.body){size+=b.length;if(size>2000000)throw fail(502,'Hugging Face response is too large.');chunks.push(b);}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail(502,'Hugging Face returned an unreadable response.');}
 }
 function profile(data){
  if(data.type!=='user'||typeof data.name!=='string'||!/^[A-Za-z0-9-]{1,42}$/.test(data.name))throw fail(400,'Use a personal Hugging Face access token.');
  return {username:data.name,organizations:(data.orgs||[]).filter(o=>typeof o.name==='string'&&/^[A-Za-z0-9-]{1,42}$/.test(o.name)).map(o=>({name:o.name,role:o.roleInOrg||'unknown'}))};
 }
 const router=express.Router();
 router.use('/api/account/huggingface',express.json({limit:'8kb'}),(req,res,next)=>{if(!req.workspaceIsOwner||(req.boardlyConnection&&!req.boardlyManagement))return res.status(403).json({error:'Only the account owner can manage Hugging Face.'});res.set('Cache-Control','no-store');next();});
 router.get('/api/account/huggingface',(req,res)=>res.json(state()));
 router.put('/api/account/huggingface',async(req,res,next)=>{try{
  const token=req.body.token,before=row()?.revision;
  if(typeof token!=='string'||!/^hf_[A-Za-z0-9]{10,2000}$/.test(token))throw fail(400,'Enter your Hugging Face access token.');
  const p=profile(await call(token,'/api/whoami-v2'));
  if(row()?.revision!==before)throw fail(409,'Connection changed. Refresh and retry.');
  db.prepare('INSERT INTO huggingface_connection VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,profile=excluded.profile,revision=excluded.revision').run(seal(token),JSON.stringify(p),crypto.randomUUID());res.json(state());
 }catch(e){next(e);}});
 router.post('/api/account/huggingface/test',async(req,res,next)=>{try{const before=row();if(!before)throw fail(409,'Connect Hugging Face first.');const p=profile(await call(decode(before),'/api/whoami-v2'));if(row()?.revision!==before.revision)throw fail(409,'Connection changed.');db.prepare('UPDATE huggingface_connection SET profile=? WHERE id=1').run(JSON.stringify(p));res.json(state());}catch(e){next(e);}});
 router.delete('/api/account/huggingface',(req,res)=>{db.prepare('DELETE FROM huggingface_connection').run();res.json(state());});
 return {router,state};
}
module.exports={createHuggingFace};
