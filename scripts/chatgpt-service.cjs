// Private, text-only Codex connector. The app supplies a server-derived account
// hash; neither clients nor models can send RPC methods, paths or credentials.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const http=require('node:http'),readline=require('node:readline'),{spawn}=require('node:child_process');
const fail=(status,message)=>Object.assign(Error(message),{status});
const schema={type:'object',additionalProperties:false,required:['text','calls'],properties:{text:{type:'string'},calls:{type:'array',items:{type:'object',additionalProperties:false,required:['name','arguments'],properties:{name:{type:'string'},arguments:{type:'string'}}}}}};
const disabled=['shell_tool','unified_exec','apply_patch_freeform','apps','plugins','hooks','plugin_hooks','multi_agent','multi_agent_mode','multi_agent_v2','browser_use','browser_use_external','in_app_browser','js_repl','code_mode','image_generation','imagegenext','memory_tool','memories','tool_suggest','skill_search'];
function safeConfig(){return ['-c','cli_auth_credentials_store="file"','-c','approval_policy="never"','-c','project_doc_max_bytes=0','-c','web_search="disabled"','-c','mcp_servers={}','-c','apps._default.enabled=false','-c','features.skip_host_skill_discovery=true',...disabled.flatMap(f=>['-c',`features.${f}=false`])];}
function createChatGPTService({root,token,command='codex',spawnProcess=spawn,loginTTL=15*60e3,runTimeout=180e3}={}){
 if(!root||!token||token.length<32)throw Error('Private ChatGPT connector configuration is required');
 fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
 const profiles=new Map();let closed=false,totalRuns=0;
 function profile(id){
  if(!/^[a-f0-9]{64}$/.test(id))throw fail(400,'Invalid account');
  let p=profiles.get(id);if(p)return p;
  const dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const home=path.join(dir,'home'),codexHome=path.join(home,'.codex');fs.mkdirSync(codexHome,{recursive:true,mode:0o700});
  p={id,dir,home,codexHome,rpc:null,pending:null,error:null,runs:new Set(),generation:0,used:Date.now(),verified:null,lock:Promise.resolve()};
  try{p.verified=JSON.parse(fs.readFileSync(path.join(dir,'verified.json'),'utf8')).at;}catch{}
  profiles.set(id,p);return p;
 }
 const environment=p=>({PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:p.home,CODEX_HOME:p.codexHome,LANG:'C.UTF-8'});
 function kill(child){if(!child.pid)return;try{process.kill(-child.pid,'SIGTERM');}catch{}const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);timer.unref();}
 function invalidate(p){p.generation++;for(const child of p.runs)kill(child);p.pending=null;p.verified=null;fs.rmSync(path.join(p.dir,'verified.json'),{force:true});}
 function serialize(p,fn){const result=p.lock.then(fn);p.lock=result.catch(()=>{});return result;}
 async function rpc(p){
  p.used=Date.now();if(p.rpc)return p.rpc.ready;
  if([...profiles.values()].filter(x=>x.rpc).length>=64)throw fail(429,'ChatGPT sign-in is busy. Please try again shortly.');
  const child=spawnProcess(command,['app-server','--listen','stdio://',...safeConfig()],{cwd:p.home,env:environment(p),detached:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let serial=0;const state={child,ready:null,stop(){kill(child);}};p.rpc=state;
  const send=(method,params)=>new Promise((resolve,reject)=>{
   const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(fail(504,'ChatGPT sign-in timed out. Please try again.'));},25000);
   pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(fail(503,'ChatGPT connection is unavailable'));}});
  });
  child.stdin.on('error',()=>{});child.stderr.resume();
  readline.createInterface({input:child.stdout}).on('line',line=>{
   let msg;try{msg=JSON.parse(line);}catch{return;}
   if(msg.id!==undefined&&pending.has(msg.id)){const r=pending.get(msg.id);pending.delete(msg.id);clearTimeout(r.timer);if(msg.error){const network=/error sending request|certificate|timed out|connection refused/i.test(msg.error.message||'');r.reject(fail(network?503:400,network?'boredly could not reach OpenAI sign-in. Please retry shortly.':'OpenAI could not complete sign-in. Enable device-code login in ChatGPT Settings → Security, then try again.'));}else r.resolve(msg.result);}
   else if(msg.method==='account/login/completed'&&p.pending?.login_id===msg.params?.loginId){p.pending=null;p.error=msg.params.success?null:'ChatGPT sign-in was not completed. Start a new code and approve it in OpenAI.';}
   // No tool/approval request is ever forwarded or approved.
  });
  const ended=()=>{if(p.rpc===state){p.rpc=null;if(p.pending){p.pending=null;p.error='ChatGPT sign-in was interrupted. Please start a new code.';}}for(const r of pending.values()){clearTimeout(r.timer);r.reject(fail(503,'ChatGPT connection was interrupted'));}pending.clear();};
  child.once('error',ended);child.once('close',ended);
  state.ready=(async()=>{await send('initialize',{clientInfo:{name:'boredly',title:'boredly',version:'1.0.0'},capabilities:{experimentalApi:false}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');return{send,stop:state.stop};})();
  try{return await state.ready;}catch(e){state.stop();throw e;}
 }
 async function status(p){
  p.used=Date.now();
  if(p.pending&&p.pending.expires_at<Date.now()){const r=await rpc(p);await r.send('account/login/cancel',{loginId:p.pending.login_id});p.pending=null;p.error='Your code expired. Start a new sign-in code.';}
  if(!p.rpc&&!fs.existsSync(path.join(p.codexHome,'auth.json')))return{connected:false,pending:null,error:p.error,verified_at:null};
  const r=await rpc(p),value=await r.send('account/read',{refreshToken:false}),account=value?.account;
  const connected=account?.type==='chatgpt';
  return{connected,email:connected?account.email:null,plan:connected?account.planType:null,pending:p.pending,error:p.error,verified_at:connected?p.verified:null};
 }
 async function login(p){return serialize(p,async()=>{
  if(p.runs.size)throw fail(409,'Wait for your current AI reply before changing its ChatGPT connection');
  if(p.pending&&p.pending.expires_at>Date.now())return status(p);
  const r=await rpc(p);if((await status(p)).connected)return status(p);
  const v=await r.send('account/login/start',{type:'chatgptDeviceCode'});
  if(v.type!=='chatgptDeviceCode'||typeof v.loginId!=='string'||typeof v.userCode!=='string'||v.userCode.length>64||v.verificationUrl!=='https://auth.openai.com/codex/device')throw fail(502,'OpenAI returned an unexpected sign-in response');
  p.error=null;p.pending={login_id:v.loginId,verification_url:v.verificationUrl,user_code:v.userCode,expires_at:Date.now()+loginTTL};
  return status(p);
 });}
 async function cancel(p){return serialize(p,async()=>{if(p.pending){const id=p.pending.login_id;p.pending=null;await(await rpc(p)).send('account/login/cancel',{loginId:id});}p.error=null;return status(p);});}
 async function disconnect(p){return serialize(p,async()=>{
  invalidate(p);const state=p.rpc;
  if(state)try{await(await state.ready).send('account/logout',{});}catch{}
  p.rpc=null;state?.stop();
  // Killing in-flight processes before erasing the profile prevents a refreshed
  // credential from reappearing after disconnect.
  await new Promise(r=>setTimeout(r,2100));
  fs.rmSync(p.home,{recursive:true,force:true});fs.mkdirSync(p.codexHome,{recursive:true,mode:0o700});p.error=null;
  return{connected:false,pending:null,verified_at:null};
 });}
 async function respond(p,payload){
  if(!payload||!Array.isArray(payload.input)||!Array.isArray(payload.tools)||!['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra'].includes(payload.model)||Buffer.byteLength(JSON.stringify(payload))>500000)throw fail(400,'This conversation is too large or its model is unsupported');
  const reservation={pid:null};let generation,temp,out,child,timer,usage={},reserved=false;
  try{
   await serialize(p,async()=>{
    if(closed)throw fail(503,'ChatGPT connector is restarting');
    if(!(await status(p)).connected)throw fail(401,'Connect your ChatGPT account in Account & AI, then resume this assignment');
    if(p.runs.size>=4||totalRuns>=16)throw fail(429,'ChatGPT is busy. Please try again shortly.');
    generation=p.generation;p.runs.add(reservation);totalRuns++;reserved=true;
    temp=fs.mkdtempSync(path.join(os.tmpdir(),'boredly-gpt-'));out=path.join(temp,'answer.json');
   });
   if(closed||generation!==p.generation)throw fail(401,'ChatGPT was disconnected. Reconnect before resuming.');
   const schemaFile=path.join(temp,'schema.json');fs.writeFileSync(schemaFile,JSON.stringify(schema),{mode:0o600});
   const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--json','--skip-git-repo-check','--sandbox','read-only',...safeConfig(),'--model',payload.model,'--output-schema',schemaFile,'-o',out,'-'];
   child=spawnProcess(command,args,{cwd:temp,env:environment(p),detached:true,stdio:['pipe','pipe','pipe']});p.runs.delete(reservation);p.runs.add(child);
   let reason=null;timer=setTimeout(()=>{reason='ChatGPT took too long to reply. Try a shorter request or resume your saved assignment.';kill(child);},runTimeout);
   const completion=new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',resolve);});
   child.stdin.on('error',()=>{});child.stderr.resume();
   readline.createInterface({input:child.stdout}).on('line',line=>{try{const event=JSON.parse(line);if(event.type==='turn.completed')usage=event.usage||{};if(event.type==='error'||event.type==='turn.failed'){const message=JSON.stringify(event);if(/usage.limit|rate.limit|quota|429|limit reached/i.test(message))reason='Your ChatGPT usage limit was reached. Check your ChatGPT plan and try again when it resets.';else if(/401|unauthorized|refresh.token|sign.in|authentication/i.test(message))reason='Your ChatGPT connection needs sign-in again. Disconnect and reconnect in Account & AI.';}}catch{}});
   child.stdin.end('Generate the next response for this boredly conversation. You have no execution tools. Return only the requested JSON. Follow the developer instructions within the supplied tool catalog. To request an action, put its catalog name and JSON-encoded arguments in calls. boredly validates and executes these separately. Never claim an action occurred before its function_call_output confirms it. Use no calls for a final answer.\n'+JSON.stringify(payload));
   const code=await completion;
   if(generation!==p.generation)throw fail(401,'ChatGPT was disconnected. Reconnect before resuming.');
   if(code!==0)throw fail(502,reason||'ChatGPT could not reply. Test the connection in Account & AI and check access to the selected model.');
   const value=JSON.parse(fs.readFileSync(out,'utf8'));
   if(typeof value.text!=='string'||!Array.isArray(value.calls)||value.calls.length>20)throw fail(502,'ChatGPT returned an invalid response');
   const output=value.text?[{type:'message',role:'assistant',content:[{type:'output_text',text:value.text}]}]:[];
   for(const c of value.calls){if(!payload.tools.some(t=>t.name===c.name)||typeof c.arguments!=='string')throw fail(502,'ChatGPT requested an unavailable action');JSON.parse(c.arguments);output.push({type:'function_call',call_id:'call_'+crypto.randomUUID(),name:c.name,arguments:c.arguments});}
   if(!output.length)throw fail(502,'ChatGPT returned an empty reply');
   return{output,usage,model:payload.model};
  }finally{clearTimeout(timer);p.runs.delete(reservation);if(child)p.runs.delete(child);if(reserved)totalRuns--;if(temp)fs.rmSync(temp,{recursive:true,force:true});p.used=Date.now();}
 }
 async function test(p){const generation=p.generation;const result=await respond(p,{model:'gpt-6-astra',input:[{role:'user',content:'Reply with one short sentence confirming that this ChatGPT connection can answer. Do not request any actions.'}],tools:[]});return serialize(p,async()=>{if(generation!==p.generation)throw fail(401,'ChatGPT was disconnected. Reconnect before testing.');p.verified=Date.now();fs.writeFileSync(path.join(p.dir,'verified.json'),JSON.stringify({at:p.verified}),{mode:0o600});return{...await status(p),reply:result.output.filter(x=>x.type==='message').flatMap(x=>x.content).map(x=>x.text).join('\n')};});}
 const timer=setInterval(()=>{for(const [id,p] of profiles){if(p.pending&&p.pending.expires_at<Date.now())serialize(p,()=>status(p)).catch(()=>{});if(!p.pending&&!p.runs.size&&Date.now()-p.used>300000){p.rpc?.stop();profiles.delete(id);}}},30000);timer.unref();
 const server=http.createServer(async(req,res)=>{
  const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(req.url==='/healthz'&&req.method==='GET')return send(200,{ok:!closed});
  const bearer=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
  if(req.headers.origin||bearer.length!==expected.length||!crypto.timingSafeEqual(bearer,expected))return send(401,{error:'Private connector authentication required'});
  const match=/^\/accounts\/([a-f0-9]{64})\/(status|login|cancel|disconnect|respond|test)$/.exec(req.url);
  if(!match||req.method!==(match[2]==='status'?'GET':'POST'))return send(404,{error:'Not found'});
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>550000)throw fail(413,'Request too large');}
   const p=profile(match[1]),action=match[2],body=raw?JSON.parse(raw):{};
   const result=await({status:()=>serialize(p,()=>status(p)),login:()=>login(p),cancel:()=>cancel(p),disconnect:()=>disconnect(p),respond:()=>respond(p,body),test:()=>test(p)})[action]();send(200,result);
  }catch(e){send(e.status||502,{error:e.status?e.message:'The ChatGPT connector could not complete this request'});}
 });
 return{server,async close(){closed=true;clearInterval(timer);for(const p of profiles.values()){p.rpc?.stop();for(const child of p.runs)kill(child);}await new Promise(r=>server.close(r));}};
}
if(require.main===module){process.umask(0o077);const service=createChatGPTService({root:process.env.CHATGPT_DATA_DIR||'/profiles',token:fs.readFileSync(process.env.CHATGPT_TOKEN_FILE,'utf8').trim()});service.server.listen(Number(process.env.PORT)||5320,'0.0.0.0');for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>service.close().then(()=>process.exit(0)));}
module.exports={createChatGPTService,safeConfig};
