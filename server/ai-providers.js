const crypto=require('node:crypto'),http=require('node:http'),express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
const definitions={claude:{label:'Claude',origin:'https://api.anthropic.com',protocol:'anthropic'},kimi:{label:'Kimi',origin:'https://api.moonshot.ai',protocol:'chat'},local:{label:'Local AI',protocol:'chat'}};
const text=v=>typeof v==='string'?v:'';
function imagePart(p,anthropic=false){
 if(p.type==='input_image'){
  if(anthropic){const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(p.image_url||'');if(!match)throw fail(400,'This provider requires an inline desktop image.');return {type:'image',source:{type:'base64',media_type:match[1],data:match[2]}};}
  return {type:'image_url',image_url:{url:p.image_url}};
 }
 return {type:'text',text:text(p.text)};
}
// Translate the existing scoped Work tools without giving a provider filesystem,
// vault or transport credentials. Opaque provider continuity is memory-only.
function messages(input,anthropic=false){
 const out=[],system=[],seen=new Set();
 const append=(role,content)=>{if(anthropic&&out.at(-1)?.role===role)out.at(-1).content.push(...content);else out.push({role,content});};
 for(const item of input||[]){
  if(item.boardly_provider_turn){if(!seen.has(item.boardly_provider_turn)){seen.add(item.boardly_provider_turn);out.push(item.boardly_provider_message);}continue;}
  if(item.type==='reasoning')continue;
  if(item.type==='function_call'){
   if(anthropic)append('assistant',[{type:'tool_use',id:item.call_id,name:item.name,input:JSON.parse(item.arguments)}]);
   else out.push({role:'assistant',content:null,tool_calls:[{id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}}]});
  }else if(item.type==='function_call_output'){
   const parts=Array.isArray(item.output)?item.output:null;
   if(anthropic)append('user',[{type:'tool_result',tool_use_id:item.call_id,content:parts?parts.map(p=>imagePart(p,true)):text(item.output)}]);
   else {out.push({role:'tool',tool_call_id:item.call_id,content:parts?'Desktop screenshot follows.':text(item.output)});if(parts)out.push({role:'user',content:parts.map(p=>imagePart(p))});}
  }else if(item.role==='developer'||item.role==='system'){
   if(anthropic)system.push(text(item.content));else out.push({role:'system',content:text(item.content)});
  }else if(item.role){
   const content=Array.isArray(item.content)?item.content.map(p=>p.type==='output_text'?{type:'text',text:p.text}:imagePart(p,anthropic)):[{type:'text',text:text(item.content)}];
   if(anthropic)append(item.role==='assistant'?'assistant':'user',content);else out.push({role:item.role,content});
  }
 }
 return {messages:out,system:system.join('\n\n')};
}
function payloadFor(connection,payload){
 const anthropic=connection.provider==='claude',converted=messages(payload.input,anthropic);
 return {model:connection.model,messages:converted.messages,max_tokens:payload.max_output_tokens||4096,...(anthropic?{system:converted.system}:{}),...(payload.tools?.length?{tools:payload.tools.map(t=>anthropic?{name:t.name,description:t.description,input_schema:t.parameters}:{type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})}:{})};
}
function outputFor(provider,result){
 const turn=crypto.randomUUID(),output=[];let message;
 if(provider==='claude'){
  if(!Array.isArray(result.content))throw fail(502,'Claude returned an invalid response.');
  message={role:'assistant',content:result.content};
  for(const part of result.content){if(part.type==='text'&&part.text)output.push({type:'message',role:'assistant',content:[{type:'output_text',text:part.text}]});else if(part.type==='tool_use')output.push({type:'function_call',call_id:part.id,name:part.name,arguments:JSON.stringify(part.input)});}
 }else{
  const raw=result.choices?.[0]?.message;if(!raw)throw fail(502,'The AI server returned an invalid response.');
  message={role:'assistant',content:raw.content||null,...(typeof raw.reasoning_content==='string'?{reasoning_content:raw.reasoning_content}:{}),...(raw.tool_calls?.length?{tool_calls:raw.tool_calls.map(c=>({id:c.id,type:'function',function:{name:c.function?.name,arguments:c.function?.arguments}}))}:{})};
  if(typeof raw.content==='string'&&raw.content)output.push({type:'message',role:'assistant',content:[{type:'output_text',text:raw.content}]});
  for(const call of raw.tool_calls||[])output.push({type:'function_call',call_id:call.id,name:call.function?.name,arguments:call.function?.arguments});
 }
 if(output.length===0)throw fail(502,'The AI server returned no usable answer. Check the selected model and output limit.');
 for(const item of output){item.boardly_provider_turn=turn;item.boardly_provider_message=message;}
 return {id:result.id||turn,output,usage:result.usage};
}
async function boundedJSON(response){
 if(!response.ok)throw fail(response.status===401?401:response.status===429?429:502,response.status===401?'The provider rejected this API key. Replace it in connector settings.':response.status===429?'The provider rate limit or balance limit was reached. Check its dashboard.':'The AI provider could not complete the request. Check the model, connection and provider dashboard.');
 let size=0,parts=[];for await(const b of response.body){size+=b.length;if(size>6000000)throw fail(502,'The AI response exceeded the supported size.');parts.push(b);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail(502,'The AI provider returned invalid JSON.');}
}
function createAIProviders({db,key,tailnet,request=fetch,account,setMode}){
 db.exec(`CREATE TABLE IF NOT EXISTS ai_provider_connections(user_id TEXT NOT NULL,provider TEXT NOT NULL,encrypted TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(user_id,provider));
 CREATE TABLE IF NOT EXISTS ai_provider_active(user_id TEXT PRIMARY KEY,provider TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_provider_calls(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,job_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,created_at INTEGER NOT NULL);`);
 db.prepare("UPDATE ai_provider_calls SET status='interrupted' WHERE status='pending'").run();
 const row=(user,provider)=>db.prepare('SELECT * FROM ai_provider_connections WHERE user_id=? AND provider=?').get(user,provider);
 const seal=(user,provider,data)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify(['ai-provider',user,provider])));return Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64');};
 const decode=r=>{const b=Buffer.from(r.encrypted,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(Buffer.from(JSON.stringify(['ai-provider',r.user_id,r.provider])));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString());};
 const current=user=>db.prepare('SELECT provider FROM ai_provider_active WHERE user_id=?').get(user)?.provider;
 function publicState(user,provider){const r=row(user,provider),c=r?decode(r):{};return {provider,label:definitions[provider].label,saved:!!r,active:account(user).mode==='provider'&&current(user)===provider,model:c.model||'',models:c.models||[],device_id:c.device_id||'',port:c.port||11434,has_key:!!c.token};}
 async function localRequest(user,c,path,body){
  const socket=await tailnet.dial(user,c.device_id,c.port),agent=new http.Agent({keepAlive:false});agent.createConnection=()=>socket;
  return new Promise((resolve,reject)=>{
   const req=http.request({host:'boardly-local-ai',port:c.port,agent,path,method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(c.token?{Authorization:'Bearer '+c.token}:{})}},res=>{
    let n=0,parts=[];res.on('data',b=>{n+=b.length;if(n>6000000)req.destroy(Error('Response too large'));else parts.push(b);});res.on('end',()=>{agent.destroy();resolve(new Response(Buffer.concat(parts),{status:res.statusCode}));});res.on('error',()=>req.destroy());
   });req.on('error',()=>{agent.destroy();reject(fail(502,'The local AI server could not be reached. Check its listening address, Tailscale device and port.'));});req.setTimeout(110000,()=>req.destroy());req.end(body?JSON.stringify(body):undefined);
  });
 }
 async function call(user,c,path,body){
  try{return await boundedJSON(c.provider==='local'?await localRequest(user,c,path,body):await request(definitions[c.provider].origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(c.provider==='claude'?{'x-api-key':c.token,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+c.token})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(body?110000:15000)}));}
  catch(e){throw e.status?e:fail(502,'The AI connection was interrupted. It was not automatically retried.');}
 }
 async function save(user,provider,data,valid){
  if(!definitions[provider])throw fail(404,'AI provider not found.');valid();const old=row(user,provider),before=old?.revision,c={provider,token:data.token|| (old?decode(old).token:'')||''};
  if(typeof c.token!=='string'||c.token.length>4000||/[\x00-\x20]/.test(c.token)||provider!=='local'&&!c.token)throw fail(400,'Enter the provider API key.');
  if(provider==='local'){
   if(typeof data.device_id!=='string'||!data.device_id||data.device_id.length>150||!Number.isInteger(data.port)||data.port<1||data.port>65535)throw fail(400,'Choose a Tailscale device and AI server port.');
   c.device_id=data.device_id;c.port=data.port;await tailnet.device(user,c.device_id);
  }
  const result=await call(user,c,'/v1/models');
  const models=Array.isArray(result.data)?result.data.map(m=>m.id).filter(id=>typeof id==='string'&&id.length<150).slice(0,500):[];
  if(!models.length)throw fail(400,'No models were returned. Load a model or check this key’s model permissions.');
  if(data.model&&!models.includes(data.model))throw fail(400,'Choose a model returned by this connection.');
  c.models=models;c.model=data.model||(old&&models.includes(decode(old).model)?decode(old).model:models[0]);valid();if(row(user,provider)?.revision!==before)throw fail(409,'Connection changed. Refresh and retry.');
  db.prepare('INSERT INTO ai_provider_connections VALUES(?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET encrypted=excluded.encrypted,revision=excluded.revision').run(user,provider,seal(user,provider,c),crypto.randomUUID());return publicState(user,provider);
 }
 function activate(user,provider){if(!row(user,provider))throw fail(400,'Connect and verify this provider first.');db.transaction(()=>{db.prepare('INSERT INTO ai_provider_active VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider').run(user,provider);setMode(user,'provider');})();return publicState(user,provider);}
 function authorize(user){const provider=current(user),r=provider&&row(user,provider);if(!r)throw fail(402,'Connect an AI provider and choose Use for Boardly agents.');const c=decode(r);return {user_id:user,mode:'provider',model:c.model,provider,revision:r.revision};}
 async function respond(a,jobId,payload){
  const r=row(a.user_id,a.provider);if(!r||r.revision!==a.revision||account(a.user_id).mode!=='provider'||current(a.user_id)!==a.provider)throw fail(409,'The AI connection changed. Start or resume with the current connection.');
  const c=decode(r),body=payloadFor(c,payload);if(Buffer.byteLength(JSON.stringify(body))>6000000)throw fail(400,'This conversation is too large for this connection.');
  const id=crypto.randomUUID();db.prepare("INSERT INTO ai_provider_calls VALUES(?,?,?,?,?,'pending',NULL,NULL,?)").run(id,a.user_id,jobId,a.provider,a.model,Date.now());
  try{
   const result=await call(a.user_id,c,a.provider==='claude'?'/v1/messages':'/v1/chat/completions',body),output=outputFor(a.provider,result),u=result.usage||{};
   const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
   db.prepare("UPDATE ai_provider_calls SET status='completed',input_tokens=?,output_tokens=? WHERE id=?").run(count(u.input_tokens??u.prompt_tokens),count(u.output_tokens??u.completion_tokens),id);
   if(row(a.user_id,a.provider)?.revision!==a.revision||account(a.user_id).mode!=='provider'||current(a.user_id)!==a.provider)throw fail(409,'The AI connection changed while the response was running.');return output;
  }catch(e){db.prepare("UPDATE ai_provider_calls SET status='interrupted' WHERE id=? AND status='pending'").run(id);throw e.status?e:fail(502,'The AI response was interrupted. Review activity before retrying.');}
 }
 const router=express.Router(),handle=fn=>async(req,res,next)=>{try{const valid=()=>{if(!req.workspaceIsOwner||req.boardlyConnection)throw fail(403,'Only the signed-in account owner can manage AI providers.');};valid();res.set('Cache-Control','no-store');res.json(await fn(req,valid));}catch(e){next(e);}};
 router.get('/api/account/ai-providers',handle(req=>({connections:Object.keys(definitions).map(p=>publicState(req.cloudUserId,p)),history:db.prepare('SELECT provider,model,status,input_tokens,output_tokens,created_at FROM ai_provider_calls WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.cloudUserId)})));
 router.put('/api/account/ai-providers/:provider',express.json({limit:'8kb'}),handle((req,v)=>save(req.cloudUserId,req.params.provider,req.body||{},v)));
 router.post('/api/account/ai-providers/:provider/activate',handle(req=>activate(req.cloudUserId,req.params.provider)));
 router.delete('/api/account/ai-providers/:provider',handle(req=>{const p=req.params.provider;if(!definitions[p])throw fail(404,'Provider not found.');db.prepare('DELETE FROM ai_provider_connections WHERE user_id=? AND provider=?').run(req.cloudUserId,p);return publicState(req.cloudUserId,p);}));
 const activeState=user=>{const p=current(user),r=p&&row(user,p);return {provider:p||null,model:r?decode(r).model:'',saved:!!r};};
 return {router,publicState,activeState,authorize,respond,save,activate};
}
module.exports={createAIProviders,payloadFor,outputFor,messages};
