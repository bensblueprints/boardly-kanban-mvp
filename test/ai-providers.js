const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const Database=require('better-sqlite3'),{fixture}=require('./member-fixture');
const {createAIProviders,payloadFor,outputFor}=require('../server/ai-providers');
(async()=>{
 const keys={claude:'test-claude-private-value',kimi:'test-kimi-private-value'},requests=[];
 let pause,waiting,shouldWait=false;
 const fake=async(url,options)=>{
  const p=url.startsWith('https://api.anthropic.com/')?'claude':'kimi';
  assert.ok(url.startsWith(p==='claude'?'https://api.anthropic.com/':'https://api.moonshot.ai/'));
  assert.equal(options.headers[p==='claude'?'x-api-key':'Authorization'],p==='claude'?keys[p]:'Bearer '+keys[p]);
  if(url.endsWith('/models'))return Response.json({data:[{id:p+'-available-model'}]});
  const body=JSON.parse(options.body);requests.push({p,body});assert.equal(body.model,p+'-available-model');assert.ok(!options.body.includes(keys[p]));
  if(shouldWait){waiting=true;await new Promise(r=>pause=r);}
  const done=body.messages.some(m=>m.role==='tool'||Array.isArray(m.content)&&m.content.some(i=>i.type==='tool_result'));
  if(p==='claude')return Response.json({id:'msg_fixture',content:done?[{type:'text',text:'Claude read the project.'}]:[{type:'tool_use',id:'tool_c',name:'get_project',input:{}}],usage:{input_tokens:31,output_tokens:11}});
  return Response.json({id:'kimi_fixture',choices:[{message:done?{role:'assistant',content:'Kimi read the project.'}:{role:'assistant',reasoning_content:'opaque test continuation',content:null,tool_calls:[{id:'tool_k',type:'function',function:{name:'get_project',arguments:'{}'}}]}}],usage:{prompt_tokens:42,completion_tokens:12}});
 };
 const f=await fixture({publicAccess:true,providerConnectorRequest:fake,providerRequest:()=>{throw Error('Provider calls must not use the OpenAI/platform billing client');}});
 try{
  for(const provider of ['claude','kimi']){
   const user='user_'+provider,p=await f.project(provider,'Provider test',user);
   const route='/api/account/ai-providers/'+provider;
   await f.api(route,{user,method:'PUT',body:{token:keys[provider],user_id:'user_owner',base_url:'http://127.0.0.1/'}});
   assert.equal((await f.api('/api/ai/settings',{user})).mode,'none','Saving does not replace active AI');
   assert.equal((await f.api('/api/account/ai-providers')).connections.find(c=>c.provider===provider).saved,false);
   await f.api(route+'/activate',{user,method:'POST'});
   const settings=await f.api('/api/ai/settings',{user});assert.equal(settings.mode,'provider');assert.equal(settings.model,provider+'-available-model');
   const thread=await f.api(`/api/boards/${p.project.id}/chat/threads`,{user,method:'POST',body:{}});
   const wait=async()=>{for(let i=0;i<200;i++){const c=await f.api(`/api/chat/threads/${thread.id}`,{user});if(c.job&&!['running','queued'].includes(c.job.status))return c;await new Promise(r=>setTimeout(r,15));}throw Error('Job did not complete');};
   await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Read my project'}});
   const c=await wait();assert.equal(c.job.status,'completed',JSON.stringify(c.job));assert.match(c.messages.at(-1).content,/read the project/);
   assert.ok(!JSON.stringify(c).includes('opaque test continuation'));
   assert.equal((await f.api('/api/ai/settings',{user})).usage.boardly_charge,0);
   const state=await f.api('/api/account/ai-providers',{user});assert.equal(state.history.length,2);assert.ok(state.history.every(h=>h.status==='completed'));assert.ok(!JSON.stringify(state).includes(keys[provider]));
   if(provider==='kimi'){
    assert.ok(requests.filter(r=>r.p==='kimi').at(-1).body.messages.some(m=>m.reasoning_content==='opaque test continuation'));
    shouldWait=true;await f.api(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Pause until revoked'}});
    while(!waiting)await new Promise(r=>setTimeout(r,5));
    await f.api(route,{user,method:'DELETE'});pause();assert.equal((await wait()).job.status,'blocked');
   }else await f.api(route,{user,method:'DELETE'});
   assert.equal((await f.api('/api/ai/settings',{user})).mode,'provider','Disconnected provider stays selected and cannot fall back to Codex');
   assert.equal((await f.request(`/api/chat/threads/${thread.id}/messages`,{user,method:'POST',body:{mode:'work',content:'No credential fallback'}})).status,402);
  }
  const p=await f.project(),member=(await f.api(`/api/companies/${p.company.id}/members`,{method:'POST',body:{email:'member@example.com'}})).member.user_id;
  assert.equal((await f.request('/api/account/ai-providers',{user:member,workspace:'user_owner'})).status,403);
  const db=new Database(path.join(f.root,'personal-ai.db'),{readonly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n,0);assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_provider_calls').all()).includes(keys.claude));db.close();
 }finally{await f.close();}
 // Check actual HTTP over a server-validated private socket, without exposing
 // an arbitrary cloud URL or falling back to a global provider account.
 const db=new Database(':memory:'),accounts=new Map(),calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/v1/models'?{data:[{id:'local-tools'}]}:{choices:[{message:{content:'Local response'}}],usage:{prompt_tokens:1,completion_tokens:2}}));});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const check=(user,device)=>{assert.equal(user,'local-owner');if(device!=='my-model-server')throw Object.assign(Error('Device not in this account network'),{status:404});};
 const providers=createAIProviders({db,key:crypto.randomBytes(32),account:u=>({mode:accounts.get(u)||'none'}),setMode:(u,m)=>accounts.set(u,m),tailnet:{async device(u,d){check(u,d);},async dial(u,d,port){check(u,d);assert.equal(port,11434);return new Promise((resolve,reject)=>{const s=net.connect(server.address().port,'127.0.0.1',()=>resolve(s));s.on('error',reject);});}}});
 try{
  await assert.rejects(()=>providers.save('local-owner','local',{device_id:'foreign-server',port:11434},()=>{}),{status:404});assert.equal(calls.length,0);
  await providers.save('local-owner','local',{device_id:'my-model-server',port:11434},()=>{});providers.activate('local-owner','local');
  const r=await providers.respond(providers.authorize('local-owner'),'job-local',{input:[{role:'user',content:'Hi'}],tools:[]});assert.equal(r.output[0].content[0].text,'Local response');assert.deepEqual(calls,['/v1/models','/v1/chat/completions']);
  assert.throws(()=>providers.authorize('different-account'),{status:402});
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
 const screenshot={type:'function_call_output',call_id:'call_s',output:[{type:'input_image',image_url:'data:image/png;base64,AAAA'}]};
 for(const provider of ['claude','kimi','local']){const p=payloadFor({provider,model:'fixture'},{input:[screenshot],tools:[]});assert.ok(JSON.stringify(p).includes(provider==='claude'?'"type":"image"':'"type":"image_url"'));}
 console.log('PASS: real Claude/Kimi project tool cycles; customer-only keys; no platform fallback or markup; opaque continuation; in-flight revocation; private local HTTP; screenshot conversion');
})().catch(e=>{console.error(e);process.exitCode=1;});
