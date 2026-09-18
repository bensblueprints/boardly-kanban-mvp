const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const {workspacePath}=require('../server/cloud'),{loadKey}=require('../server/project-environment');
const {createGithubConnections}=require('../server/github-connections'),Database=require('better-sqlite3');
async function native(){
 const f=await fixture({publicAccess:true});
 try{
  const p=await f.project('Saved company','Shared source'),other=await f.project('Other company','Private source');
  const user=(await f.api(`/api/projects/${p.project.id}/members`,{method:'POST',body:{email:'source@example.com',role:'editor'}})).member.user_id;
  const old=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});
  const context=`/api/boards/${p.project.id}/chat/context`,settings=`/api/companies/${p.company.id}/github`;
  assert.equal((await f.api(context)).github.saved,false);
  const token='github_pat_fixture_'+crypto.randomBytes(24).toString('hex');
  const saved=await f.api(settings,{method:'PUT',body:{repository:'northstar/website',branch:'production',token,allow_agent:true}});
  const v=await f.api(context);assert.equal(v.github.repository,'northstar/website');assert.equal(v.github.inherited,true);assert.ok(!JSON.stringify(v).includes(token));assert.ok(!JSON.stringify(v).includes('encrypted'));
  // The stored credential decrypts after opening an independent database and connector.
  const db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  const restored=createGithubConnections({db,key:loadKey(f.root),namespace:'user_owner',request:async(auth,route)=>{assert.equal(auth,token);return route.includes('/git/ref/')?{object:{sha:'a'.repeat(40)}}:{permissions:{push:true}};}});
  assert.equal(restored.context(p.project.id).branch,'production');await restored.operate(restored.effective(p.project.id),'test');db.close();
  const key=await f.api('/api/connections',{method:'POST',body:{name:'GitHub chat QA',scope:'worker'}});
  async function worker(route,body={}){const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+key.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();}
  for(const [i,mode] of ['ask','plan','work'].entries()){
   const t=i===1?await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}}):old;
   await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode,content:'Which GitHub connection is saved?'}});
   const j=(await worker('/api/worker/claim')).job;assert.equal(j.mode,mode);
   const github=mode==='work'?j.github[0]:j.context[0].github;
   assert.equal(github.repository,'northstar/website');assert.equal(github.branch,'production');assert.ok(!JSON.stringify(j).includes(token));assert.ok(!JSON.stringify(j).includes('encrypted'));
   await f.api(`/api/chat/jobs/${j.id}/cancel`,{method:'POST',body:{}});await worker(`/api/worker/jobs/${j.id}`,{status:'cancelled'});
  }
  // Company discussions get current per-project settings in a fresh conversation too.
  const org=await f.api(`/api/agents/company/${p.company.id}/threads`,{method:'POST',body:{}});
  await f.api(`/api/discussions/threads/${org.id}/messages`,{method:'POST',body:{mode:'plan',content:'Plan work with our saved repository'}});
  const discussion=(await worker('/api/worker/claim')).job;assert.equal(discussion.context.projects[0].github.repository,'northstar/website');
  await f.api(`/api/discussions/jobs/${discussion.id}/cancel`,{method:'POST',body:{}});
  assert.equal((await f.api(`/api/agents/company/${p.company.id}`)).github[0].repository,'northstar/website');
  await f.api(settings,{method:'PUT',body:{branch:'next-release',token:'',allow_agent:false}});
  assert.equal((await f.api(context)).github.branch,'next-release');assert.equal((await f.api(context)).github.status,'paused');
  assert.equal((await f.api(`/api/boards/${other.project.id}/chat/context`)).github.saved,false);
  const member={user,workspace:'user_owner'};assert.equal((await f.api(context,member)).github.status,'restricted');assert.ok(!JSON.stringify(await f.api(context,member)).includes('northstar'));
  const grant=(await f.api(`/api/projects/${p.project.id}/members`)).members[0].grant_id;await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['github']}});
  assert.equal((await f.api(context,member)).github.repository,'northstar/website');assert.equal((await f.request(`/api/boards/${other.project.id}/chat/context`,member)).status,404);
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:[]}});assert.equal((await f.api(context,member)).github.status,'restricted');
  assert.equal((await f.api(settings)).connection.id,saved.id);
  console.log('PASS: durable encrypted GitHub settings, independent reopen/decryption, existing/new Ask Plan Work and company chats, branch/pause refresh and member/project isolation');
 }finally{await f.close();}
}
async function hosted(){
 const remote=githubFixture();let seen=[];
 const f=await fixture({githubRequest:remote.request,providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const body=JSON.parse(opts.body);seen.push(body);const summary=body.input.find(i=>i.content?.startsWith('Current saved GitHub connection:'));
  assert.ok(summary.content.includes('northstar/website'));assert.ok(!JSON.stringify(body).includes('boardly_connection_context'));assert.ok(!JSON.stringify(body).includes('github_pat_fixture_'));
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Your saved GitHub connection is available.'}]}]});
 }});
 try{
  const p=await f.project();await f.api(`/api/projects/${p.project.id}/github`,{method:'PUT',body:{repository:'northstar/website',branch:'main',token:'github_pat_fixture_'+crypto.randomBytes(24).toString('hex'),allow_agent:true}});
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  for(const mode of ['ask','plan','work']){
   const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode,content:'Which repository is saved?'}});
   let h;for(let i=0;i<100;i++){h=await f.api(`/api/chat/threads/${t.id}`);if(!['queued','running'].includes(h.job.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(h.job.status,'completed',h.job.error);
   if(mode!=='work')assert.deepEqual(seen.at(-1).tools,[]);
  }
  assert.equal(seen.length,3);console.log('PASS: hosted Ask Plan Work refresh saved repository metadata without exposing tokens or granting discussion tools');
 }finally{await f.close();}
}
(async()=>{await native();await hosted();})().catch(e=>{console.error(e);process.exitCode=1;});
