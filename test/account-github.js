const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const {workspacePath}=require('../server/cloud'),{loadKey}=require('../server/project-environment'),{createGithubConnections}=require('../server/github-connections');
(async()=>{
 const remote=githubFixture(),tokens=[],pat='github_pat_fixture_'+crypto.randomBytes(24).toString('hex'),replacement=pat+'new',scoped=pat+'scoped';let hold,started,release;
 const request=async(token,route,options)=>{tokens.push(token);if(hold){hold=false;started();await new Promise(r=>release=r);}return route==='/user'?{login:'fixture-owner'}:remote.request(token,route,options);};
 const f=await fixture({publicAccess:true,githubRequest:request});let db;
 try{
  const a=await f.project('Company A','Project A'),b=await f.project('Company B','Project B'),base='/api/account/github',company=`/api/companies/${a.company.id}/github`,project=`/api/projects/${a.project.id}/github`;
  assert.equal((await f.api(base)).has_token,false);
  await f.api(company,{method:'PUT',body:{repository:'northstar/company',allow_agent:true}});
  assert.equal((await f.api(project)).effective.credential_ready,false);
  assert.equal((await f.request(project+'/test',{method:'POST',body:{}})).status,409);
  await f.api(base,{method:'PUT',body:{token:pat}});assert.equal((await f.api(base+'/test',{method:'POST',body:{}})).login,'fixture-owner');
  await f.api(company+'/test',{method:'POST',body:{}});
  await f.api(`/api/companies/${b.company.id}/github`,{method:'PUT',body:{repository:'different-org/second',allow_agent:true}});
  db=new(require('better-sqlite3'))(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  const create=()=>createGithubConnections({db,key:loadKey(f.root),namespace:'user_owner',request});let github=create();
  assert.equal(github.effective(a.project.id).inherited,true);assert.equal(github.effective(b.project.id).repository,'different-org/second');
  const run=(action='status',data={},ssh)=>github.run({projectId:a.project.id,companyId:a.company.id,connectionId:github.effective(a.project.id).id,action,data,ssh});
  await run();assert.equal(tokens.at(-1),pat);
  await f.api(project,{method:'PUT',body:{repository:'another-org/override',allow_agent:true}});await run();assert.ok(remote.calls.at(-1).route.startsWith('/repos/another-org/override/'));
  await f.api(project,{method:'PUT',body:{allow_agent:false}});assert.equal(github.agentList(a.project.id).length,0);await assert.rejects(run(),/not enabled/);
  await f.api(project,{method:'DELETE'});assert.equal(github.effective(a.project.id).repository,'northstar/company');
  const added=await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'github@example.com',role:'editor'}}),user=added.member.user_id;
  const grant=(await f.api(`/api/companies/${a.company.id}/members`)).members[0].grant_id;await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['github']}});
  const member={user,workspace:'user_owner'};
  for(const method of ['GET','PUT','DELETE','POST'])assert.equal((await f.request(base+(method==='POST'?'/test':''),{...member,method,...(['PUT','POST'].includes(method)?{body:{token:pat}}:{})})).status,403);
  assert.equal((await f.api(base,{user:'user_other'})).has_token,false);
  assert.equal((await f.request(company,{...member,method:'PUT',body:{repository:'private/other'}})).status,403);
  assert.equal((await f.request(project,{...member,method:'PUT',body:{repository:'private/other'}})).status,403);
  await f.api(company,{...member,method:'PUT',body:{allow_agent:false}});await f.api(company,{...member,method:'PUT',body:{allow_agent:true}});
  await f.api(company+'/test',{...member,method:'POST',body:{}});
  await f.api(project,{...member,method:'PUT',body:{repository:'member/own',token:scoped,allow_agent:true}});await run();assert.equal(tokens.at(-1),scoped);
  assert.equal((await f.request(project,{...member,method:'PUT',body:{credential_source:'account'}})).status,403);
  assert.equal((await f.request(project,{...member,method:'PUT',body:{repository:'private/other'}})).status,403);
  await f.api(base,{method:'DELETE'});await run();assert.equal(tokens.at(-1),scoped,'Separate repository credentials survive account removal');
  await f.api(project,{method:'DELETE'});assert.equal(github.context(a.project.id).status,'needs_token');assert.equal(github.agentList(a.project.id).length,0);await assert.rejects(run(),/owner must add/);
  await f.api(base,{method:'PUT',body:{token:pat}});const before=github.effective(a.project.id);
  await f.api(base,{method:'PUT',body:{token:replacement}});assert.equal(github.effective(a.project.id).tested_at,null);await assert.rejects(github.operate(before,'status'),/credential changed/);await run();assert.equal(tokens.at(-1),replacement);
  // Rotation and deletion interrupt a provider operation before it can continue or return data.
  for(const route of [company+'/test',base+'/test']){
   hold=true;const ready=new Promise(r=>started=r),pending=f.request(route,{method:'POST',body:{}});await ready;
   await f.api(base,{method:'DELETE'});await f.api(base,{method:'PUT',body:{token:pat}});release();assert.equal((await pending).status,403);
  }
  await run('deploy',{sha:remote.head,verification:'Fixture checks passed',command:'deploy',ssh_connection_id:'fixture'}, {forJob:()=>({id:'fixture',updated_at:1}),execute:async(row,opts)=>{assert.ok(opts.valid());await f.api(base,{method:'DELETE'});assert.equal(opts.valid(),false);return{code:1};}});
  await f.api(base,{method:'PUT',body:{token:pat}});db.close();db=new(require('better-sqlite3'))(path.join(workspacePath(f.root,'user_owner'),'app.db'));github=create();await run();assert.equal(tokens.at(-1),pat);
  const raw=db.prepare('SELECT encrypted FROM github_account_credentials').get();assert.ok(!raw.encrypted.includes(pat));
  for(const data of [await f.api(base),await f.api(company),github.context(a.project.id),github.agentList(a.project.id)])assert.ok(!JSON.stringify(data).includes(pat));
  assert.ok(!fs.readFileSync(path.join(workspacePath(f.root,'user_owner'),'app.db')).includes(Buffer.from(pat)));assert.ok(!github.redact('secret '+pat).includes(pat));
  const other=createGithubConnections({db,key:loadKey(f.root),namespace:'user_other',request});await assert.rejects(other.operate(other.effective(a.project.id),'status'));
  // A legacy schema migrates without changing its repository ciphertext.
  await f.api(project,{method:'PUT',body:{repository:'legacy/website',token:scoped,allow_agent:true}});const legacy=db.prepare('SELECT * FROM github_connections').all();db.exec('ALTER TABLE github_connections DROP COLUMN credential_source');github=create();await run();assert.equal(tokens.at(-1),scoped);for(const row of legacy)assert.equal(db.prepare('SELECT encrypted FROM github_connections WHERE id=?').get(row.id).encrypted,row.encrypted);
  console.log('PASS: encrypted account PAT, company/project precedence, multiple repositories, owner isolation, member binding restrictions, legacy migration, live rotation/removal and deployment revocation');
 }finally{if(db)db.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
