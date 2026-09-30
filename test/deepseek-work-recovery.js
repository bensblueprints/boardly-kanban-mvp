const assert=require('node:assert/strict'),crypto=require('node:crypto'),Database=require('better-sqlite3');
const {payloadFor,outputFor,createAIProviders}=require('../server/ai-providers');
const {failureKind}=require('../server/runtime-policy');
const call=id=>({type:'function_call',call_id:id,name:'read_file',arguments:'{"id":1}'});
const result=(id,output='saved result')=>({type:'function_call_output',call_id:id,output});

(async()=>{
 const checkpoint=[{role:'developer',content:'Use saved results; do not replay actions.'},call('a'),call('b'),result('a'),result('b')];
 const converted=payloadFor({provider:'deepseek',model:'deepseek-v4-pro'},{input:checkpoint,max_output_tokens:4096});
 assert.deepEqual(converted.thinking,{type:'disabled'});
 assert.deepEqual(converted.messages.map(m=>m.role),['system','assistant','tool','tool']);
 assert.deepEqual(converted.messages[1].tool_calls.map(c=>c.id),['a','b']);
 assert.equal(converted.messages[2].tool_call_id,'a');assert.equal(converted.messages[3].tool_call_id,'b');
 assert.equal(checkpoint.filter(m=>m.type==='function_call').length,2,'Conversion does not mutate checkpoints');
 const withImage=payloadFor({provider:'deepseek',model:'test'},{input:[call('a'),call('b'),result('a',[{type:'input_image',image_url:'data:image/png;base64,AAAA'}]),result('b')]});
 assert.deepEqual(withImage.messages.map(m=>m.role),['assistant','tool','tool','user'],'Screenshots follow all parallel tool results');
 for(const provider of ['claude','kimi','local','openwebui'])assert.equal(payloadFor({provider,model:'test'},{input:[]}).thinking,undefined,'Other providers keep their mode');
 const good={choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'a',type:'function',function:{name:'read_file',arguments:'{"id":1}'}},{id:'b',type:'function',function:{name:'read_file',arguments:'{"id":2}'}}]}}]};
 const live=outputFor('deepseek',good).output;
 assert.equal(payloadFor({provider:'deepseek',model:'test'},{input:[...live,result('a'),result('b')]}).messages[0].tool_calls.length,2,'Opaque live turns are not duplicated');
 for(const raw of [
   {choices:[{finish_reason:'length',message:{content:'partial',tool_calls:[{id:'truncated',function:{name:'update_task',arguments:'{"id":'}}]}}]},
   {choices:[{finish_reason:'length',message:{content:'',reasoning_content:'private'}}]},
   {choices:[{finish_reason:'stop',message:{content:''}}]},
   {choices:[]},
 ])assert.throws(()=>outputFor('deepseek',raw),e=>e.retryable===false&&failureKind(e)==='review');
 assert.equal(failureKind({status:503}),'transient','Real service outages remain retryable');

 const db=new Database(':memory:');const seen=[];
 const providers=createAIProviders({db,key:crypto.randomBytes(32),account:()=>({mode:'none'}),setMode:()=>{},request:async(url,options)=>{
   if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-v4-pro'}]});
   seen.push(JSON.parse(options.body));
   return Response.json({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'private'}}],usage:{prompt_tokens:500,completion_tokens:4096}});
 }});
 try{
   for(const companyId of [4,24]){
     await providers.save('owner','deepseek',{token:'test-secret-no-real-credentials'},()=>{},companyId);
     const auth=await providers.authorizeSelection('owner','deepseek','deepseek-v4-pro',companyId,()=>{});
     await assert.rejects(providers.respond(auth,'company-'+companyId,{input:checkpoint}),e=>e.retryable===false);
   }
   assert.equal(seen.length,2);assert.ok(seen.every(p=>p.thinking.type==='disabled'));
   const rows=db.prepare('SELECT status,input_tokens,output_tokens FROM ai_provider_calls').all();
   assert.ok(rows.every(r=>r.status==='interrupted'&&r.input_tokens===500&&r.output_tokens===4096),'Incomplete output retains billed usage');
 }finally{db.close();}
 console.log('PASS: DeepSeek company routing, checkpoint parallel-call replay, screenshot ordering, terminal output errors, and usage accounting');
})().catch(e=>{console.error(e);process.exitCode=1;});
