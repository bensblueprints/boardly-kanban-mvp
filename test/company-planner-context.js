const assert=require('node:assert/strict'),crypto=require('node:crypto'),{fixture}=require('./member-fixture');
const {parseResponse}=require('../server/company-onboarding');
(async()=>{
 assert.equal(parseResponse({output_text:'A readable ordinary answer.'}).reply,'A readable ordinary answer.');
 assert.equal(parseResponse({output_text:'Here is a plan:\n```json\n{"reply":"Review this {plan}","projects":[]}\n```'}).reply,'Review this {plan}');
 assert.equal(parseResponse({output_text:'<think>Private reasoning</think>Visible answer'}).reply,'Visible answer');
 assert.throws(()=>parseResponse({output:[{type:'reasoning',content:[{text:'private reasoning'}]}]}));
 const calls=[],reads=[],sha='a'.repeat(40),tree='b'.repeat(40),token='github-fixture-token-1234567890';let answer='Your attached repository contains the application. Which release should we plan first?';
 const f=await fixture({providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'org-model'},{id:'company-model'}]});
  const body=JSON.parse(options.body);calls.push(body);return Response.json({choices:[{message:{content:answer}}]});
 },githubRequest:async(key,route,options)=>{
  assert.equal(key,token);assert.ok(!options?.method||options.method==='GET');reads.push(route);
  if(route.includes('/git/ref/heads/'))return {object:{sha}};
  if(route.includes('/git/commits/'))return {tree:{sha:tree}};
  if(route.includes('/git/trees/'))return {tree:[{type:'blob',path:'README.md',size:100},{type:'blob',path:'.env',size:20},{type:'blob',path:'package.json',size:40}]};
  if(route.includes('/contents/'))return {type:'file',encoding:'base64',size:100,content:Buffer.from(route.includes('README')?'# Fixture App\nWorkflow builder and API.':'{"name":"fixture-app"}').toString('base64')};
  throw Error('Unexpected repository request '+route);
 }});
 const post=(path,body)=>f.api(path,{method:'POST',body}),put=(path,body)=>f.api(path,{method:'PUT',body});
 async function wait(id){for(let i=0;i<200;i++){const d=await f.api('/api/company-onboarding/drafts/'+id);if(d.turns.length&&!d.turns.some(t=>['queued','running'].includes(t.status)))return d;await new Promise(r=>setTimeout(r,15));}throw Error('Planner timed out');}
 try{
  const a=await f.project('Hyper Fixture','Existing Board');
  await put('/api/account/ai-providers/deepseek',{token:'deepseek-fixture-key',model:'org-model'});await post('/api/account/ai-providers/deepseek/activate',{});
  await put(`/api/companies/${a.company.id}/ai`,{source:'organization',provider:'deepseek',model:'company-model'});
  await put(`/api/companies/${a.company.id}/github`,{repository:'fixture/app',branch:'main',token,allow_agent:true});
  let d=await post('/api/company-onboarding/drafts',{request_id:crypto.randomUUID(),company_id:a.company.id});
  const message=async content=>{await post(`/api/company-onboarding/drafts/${d.id}/messages`,{client_id:crypto.randomUUID(),version:d.version,content});d=await wait(d.id);return d;};
  await message('The repo is attached in settings.');assert.equal(d.turns.at(-1).status,'completed');assert.equal(d.turns.at(-1).reply,answer);assert.equal(d.brief.name,'Hyper Fixture');
  assert.equal(calls.at(-1).model,'company-model','Company builder honors Company override');
  const evidence=calls.at(-1).messages.map(m=>JSON.stringify(m.content)).join('\n');assert.match(evidence,/fixture\/app/);assert.match(evidence,/Workflow builder and API/);assert.match(evidence,/company-model/);assert.ok(!evidence.includes(token));assert.ok(!reads.some(r=>r.includes('/contents/.env')));
  const saved=structuredClone(d.brief);answer=JSON.stringify({reply:'A useful reply despite invalid plan data.',brief:{website:'bad URL'},projects:[{name:'Malformed'}],suggestions:[null,'Good suggestion',123]});
  await message('Draft the projects.');assert.equal(d.turns.at(-1).status,'completed');assert.match(d.turns.at(-1).reply,/saved brief and project plan are unchanged/);assert.deepEqual(d.brief,saved);assert.deepEqual(d.projects,[]);assert.deepEqual(d.turns.at(-1).suggestions,['Good suggestion']);
  await put(`/api/companies/${a.company.id}/github`,{allow_agent:false});const readCount=reads.length;answer='The repository connection is paused.';await message('Check the saved connection.');assert.equal(reads.length,readCount);assert.match(JSON.stringify(calls.at(-1).messages),/paused/);
  assert.equal((await f.api('/api/hierarchy')).projects.length,1,'Planner proposes changes without creating or assigning work before review');
  console.log('PASS: Company planner uses Company model and saved GitHub evidence, reads only bounded documentation, respects paused connections, accepts conversational/fenced replies and preserves reviewed data on malformed suggestions.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
