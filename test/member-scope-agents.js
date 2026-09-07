const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const answer={type:'message',role:'assistant',content:[{type:'output_text',text:'Permission checks completed.'}]};
const call=(name,args)=>({type:'function_call',id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),name,arguments:JSON.stringify(args)});
const response=output=>Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens:50},output});
(async()=>{
 const remote=githubFixture();let phase='denied',step=0,pendingModel,modelStarted,pendingGithub,githubStarted,holdGithub=false,sshId;
 const f=await fixture({githubRequest:async(...args)=>{if(holdGithub){holdGithub=false;githubStarted?.();await new Promise(resolve=>pendingGithub=resolve);}return remote.request(...args);},providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const body=JSON.parse(opts.body),privileged=body.tools.filter(t=>t.name.startsWith('github_')||t.name.includes('ssh'));
  if(phase==='denied'||step>0)assert.equal(privileged.length,0,'Unpermitted tools are not advertised');
  else {assert.ok(privileged.some(t=>t.name==='execute_ssh'));assert.ok(privileged.some(t=>t.name==='github_deploy'));}
  if(step++===0){if(phase==='revoke'){modelStarted?.();await new Promise(resolve=>pendingModel=resolve);}return response([call('github_status',{}),call('execute_ssh',{connection_id:sshId,command:'printf forbidden'})]);}
  const outputs=body.input.filter(i=>i.type==='function_call_output');assert.ok(outputs.length>=2);for(const item of outputs.slice(-2))assert.match(JSON.parse(item.output).error,/permission scope/);
  return response([answer]);
 }});
 try{
  const p=await f.project('Scoped company','Scoped project');
  const member=await f.api(`/api/projects/${p.project.id}/members`,{method:'POST',body:{email:'agent@example.com',role:'editor'}}),user=member.member.user_id;
  const grant=(await f.api(`/api/projects/${p.project.id}/members`)).members[0].grant_id;
  const set=scopes=>f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes}});
  await f.api(`/api/projects/${p.project.id}/github`,{method:'PUT',body:{repository:'northstar/website',branch:'main',token:'github_pat_fixture_'+crypto.randomBytes(24).toString('hex'),allow_agent:true}});
  const ssh=await f.api(`/api/projects/${p.project.id}/ssh`,{method:'POST',body:{label:'Never dial',host:'127.0.0.1',port:9,username:'fixture',auth_type:'password',password:'synthetic',fingerprint:'SHA256:'+'a'.repeat(43),allow_agent:true}});sshId=ssh.id;
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:20,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  async function start(){const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{user,method:'POST',body:{}});await f.api(`/api/chat/threads/${t.id}/messages`,{user,method:'POST',body:{mode:'work',content:'Check scoped tools.'}});return t;}
  async function finish(t){for(let n=0;n<150;n++){const h=await f.api(`/api/chat/threads/${t.id}`);if(!['queued','running'].includes(h.job.status)){assert.equal(h.job.status,'completed',h.job.blocker||h.job.error);return h;}await new Promise(r=>setTimeout(r,20));}throw Error('Agent did not finish');}
  await finish(await start());assert.equal(remote.calls.length,0,'No GitHub preflight without scope');
  await set(['ssh','github']);phase='revoke';step=0;
  const modelReady=new Promise(resolve=>modelStarted=resolve),t=await start();await modelReady;
  const before=remote.calls.length;await set([]);pendingModel();await finish(t);
  assert.equal(remote.calls.length,before,'Revocation blocks model-returned calls before provider access');
  await set(['github']);holdGithub=true;const githubReady=new Promise(resolve=>githubStarted=resolve);
  const checking=f.request(`/api/projects/${p.project.id}/github/test`,{user,method:'POST',body:{}});await githubReady;await set([]);pendingGithub();
  assert.equal((await checking).status,403,'An in-flight connection test rechecks membership before returning data');
  const setting=(await f.api(`/api/projects/${p.project.id}/github`)).connection;assert.equal(setting.tested_at,null);
  // Revoking Members during the asynchronous identity lookup cannot commit a grant.
  await set(['members']);const original=f.identity.users.getUserList;let releaseLookup,lookupStarted;
  f.identity.users.getUserList=async args=>{if(args.emailAddress.includes('new@example.com')){lookupStarted?.();await new Promise(resolve=>releaseLookup=resolve);}return original(args);};
  const lookupReady=new Promise(resolve=>lookupStarted=resolve),adding=f.request(`/api/projects/${p.project.id}/members`,{user,method:'POST',body:{email:'new@example.com',role:'viewer'}});
  await lookupReady;await set([]);releaseLookup();assert.equal((await adding).status,403);
  assert.ok(!(await f.api(`/api/projects/${p.project.id}/members`)).members.some(m=>m.email==='new@example.com'));
  console.log('PASS: unadvertised tool denial, no unauthorized GitHub preflight, scope revocation during model/provider calls and member provisioning');
 }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
