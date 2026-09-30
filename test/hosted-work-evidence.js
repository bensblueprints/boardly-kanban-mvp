const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const {implementationRequested}=require('../server/work-evidence');
assert.equal(implementationRequested('Build the desktop software feature'),true);
for(const text of ['Organize tasks for the app','Just review the software','Write the architecture plan for the app','Which repository is saved?'])assert.equal(implementationRequested(text),false,text);
for(const [scope,expected] of [['Software Development / Desktop App & UI',true],['Software Development / Core Engine',true],['Software Development / Product & Architecture',false],['Marketing / Content & SEO',false]])assert.equal(implementationRequested(`Work as the agent for ${scope} in the Example swarm. Shared objective: Build the software feature\nYour assignment: Apply the shared objective to this project.`),expected,scope);
async function scenario(kind){
 const remote=githubFixture();let calls=0,project,readResult;
 const f=await fixture({githubRequest:remote.request,providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const body=JSON.parse(opts.body);calls++;
  assert.ok(!JSON.stringify(body).includes('boardly_work_evidence'));
  let tool,args;
  if(calls===1){tool='github_read_file';args={sha:remote.head,path:'src/app.js',start_line:0,max_lines:300};}
  if(calls===2){readResult=JSON.parse(body.input.find(x=>x.type==='function_call_output').output);assert.equal(readResult.text,'original source\n');assert.equal(readResult.start_line,1);
   if(kind==='source'){tool='github_commit_files';args={base_sha:remote.head,message:'Fix application output',files:[{path:'src/app.js',content:'module.exports = 42;\n'}]};}
   else if(kind==='docs'){tool='github_commit_files';args={base_sha:remote.head,message:'Write plan',files:[{path:'docs/plan.md',content:'Implementation remains to do.'}]};}
   else {tool='create_task';args={list_id:project.list.id,title:'Implement later',description:'Planning only'};}
  }
  const output=tool?[{type:'function_call',id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),name:tool,arguments:JSON.stringify(args)}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Completed the assignment.'}]}];
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,output_tokens:30},output});
 }});
 try{
  project=await f.project('Evidence test','Desktop app');
  await f.api(`/api/projects/${project.project.id}/github`,{method:'PUT',body:{repository:'northstar/website',branch:'main',token:'github_pat_fixture_'+crypto.randomBytes(24).toString('hex'),allow_agent:true}});
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  const t=await f.api(`/api/boards/${project.project.id}/chat/threads`,{method:'POST',body:{}});
  await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:kind==='planning'?'Organize tasks for the app':'Implement the application feature'}});
  let h;for(let i=0;i<200;i++){h=await f.api(`/api/chat/threads/${t.id}`);if(!['queued','running'].includes(h.job.status))break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(h.job.status,['source','planning'].includes(kind)?'completed':'blocked',JSON.stringify(h.job));
  if(h.job.status==='blocked'){assert.equal(calls,5);assert.match(h.job.blocker,/No repository source changes/);assert.ok(!h.messages.some(x=>x.role==='assistant'&&x.content==='Completed the assignment.'));}
  assert.ok(h.job.activity.some(x=>x.title==='github read file'&&x.detail.includes('src/app.js')));
  console.log('PASS: hosted '+kind+' completion behavior and real GitHub read dispatch');
 }finally{await f.close();}
}
(async()=>{for(const kind of ['tasks','docs','source','planning'])await scenario(kind);})().catch(e=>{console.error(e);process.exitCode=1;});
