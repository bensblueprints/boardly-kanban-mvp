const assert=require('node:assert/strict');
const {fixture}=require('./member-fixture');
(async()=>{
 const account='github_pat_fixture_account_1234567890',separate='github_pat_fixture_separate_1234567890',calls=[];let mode='normal',hold,ready,release;
 const repos=Array.from({length:101},(_,i)=>({full_name:`team/repo-${String(i).padStart(3,'0')}`,default_branch:i===100?'production':'main',private:true,archived:false,temp_clone_token:account,owner:{private_field:'hidden'}}));
 const f=await fixture({publicAccess:true,githubRequest:async(token,route)=>{
  calls.push({token,route});if(hold){hold=false;ready();await new Promise(r=>release=r);}
  if(mode==='forbidden')throw Object.assign(Error('GitHub denied access. Check token permissions, organization approval and rate limits.'),{status:403});
  if(mode==='malformed')return [{full_name:'https://evil.test/repo',default_branch:'main'}];
  if(mode==='empty')return [];
  const url=new URL(route,'https://api.github.com');assert.equal(url.pathname,'/user/repos');assert.equal(url.searchParams.get('per_page'),'100');assert.equal(url.searchParams.get('sort'),'full_name');
  const page=Number(url.searchParams.get('page'));return repos.slice((page-1)*100,page*100);
 }});
 try{
  const p=await f.project(),base=`/api/projects/${p.project.id}/github`,company=`/api/companies/${p.company.id}/github`,list=(route=base,body={},options={})=>f.api(route+'/repositories',{...options,method:'POST',body});
  assert.equal((await f.request(base+'/repositories',{method:'POST',body:{}})).status,409);assert.equal(calls.length,0);
  await f.api('/api/account/github',{method:'PUT',body:{token:account}});
  const first=await list();assert.equal(first.repositories.length,100);assert.equal(first.next_page,2);assert.equal(calls.at(-1).token,account);assert.equal(first.repositories[0].private,true);assert.ok(!JSON.stringify(first).includes(account));assert.equal(first.repositories[0].owner,undefined);assert.equal(first.repositories[0].temp_clone_token,undefined);
  const last=await list(base,{page:2,credential_version:first.credential_version});assert.equal(last.repositories[0].default_branch,'production');assert.equal(last.next_page,null);
  assert.equal((await list(company)).repositories.length,100);
  for(const page of [0,-1,1.5,'2',10001])assert.equal((await f.request(base+'/repositories',{method:'POST',body:{page}})).status,400);
  assert.equal((await f.request(base+'/repositories',{method:'POST',body:{credential_source:'invalid'}})).status,400);
  const member=await f.api(`/api/projects/${p.project.id}/members`,{method:'POST',body:{email:'picker@example.com',role:'editor'}}),user=member.member.user_id;
  const grant=(await f.api(`/api/projects/${p.project.id}/members`)).members[0].grant_id,opts={user,workspace:'user_owner'};
  const before=calls.length;assert.equal((await f.request(base+'/repositories',{...opts,method:'POST',body:{credential_source:'scoped',token:separate}})).status,403);assert.equal(calls.length,before);
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['github']}});
  assert.equal((await f.request(base+'/repositories',{...opts,method:'POST',body:{}})).status,403);
  await f.api(base,{method:'PUT',body:{repository:'team/repo-000',token:separate,allow_agent:true}});
  assert.equal((await f.request(base+'/repositories',{...opts,method:'POST',body:{credential_source:'scoped'}})).status,403);
  await list(base,{credential_source:'scoped'});assert.equal(calls.at(-1).token,separate);
  await list(base,{credential_source:'scoped',token:separate},opts);assert.equal(calls.at(-1).token,separate);
  assert.equal((await f.request(company+'/repositories',{...opts,method:'POST',body:{credential_source:'scoped',token:separate}})).status,403);
  assert.equal((await f.request(base+'/repositories',{user:'user_other',method:'POST',body:{}})).status,404);
  // Check revocation during provider reads, and between pages.
  for(const scenario of ['account','scoped','member']){
   hold=true;const waiting=new Promise(r=>ready=r),pending=f.request(base+'/repositories',{...(scenario==='member'?opts:{}),method:'POST',body:scenario==='account'?{}:{credential_source:'scoped',...(scenario==='member'?{token:separate}:{})}});await waiting;
   if(scenario==='account')await f.api('/api/account/github',{method:'PUT',body:{token:account+'new'}});
   if(scenario==='scoped')await f.api(base,{method:'DELETE'});
   if(scenario==='member')await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:[]}});
   release();assert.equal((await pending).status,403);
  }
  assert.equal((await f.request(base+'/repositories',{method:'POST',body:{page:2,credential_version:first.credential_version}})).status,409);
  mode='empty';assert.deepEqual((await list()).repositories,[]);
  mode='malformed';assert.equal((await f.request(base+'/repositories',{method:'POST',body:{}})).status,502);
  mode='forbidden';assert.equal((await f.request(base+'/repositories',{method:'POST',body:{}})).status,403);
  assert.equal((await f.api(base)).connection,null,'Discovery never saves or rebinds a repository');
  console.log('PASS: paginated repository discovery, minimal metadata/default branches, account/scoped tokens, tenant/member isolation, in-flight and between-page revocation, empty/error responses and no assignment mutation');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
