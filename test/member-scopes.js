const assert=require('node:assert/strict');
const {fixture}=require('./member-fixture');
const all=['ssh','github','environment','payments','members'];
(async()=>{
 const f=await fixture();
 try{
  const a=await f.project('Clothing Company','Nasdo'),b=await f.project('Private Company','Private');
  const sibling=await f.api('/api/projects',{method:'POST',body:{name:'Sibling',parent_board_id:a.board.id}});
  const added=await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'editor@example.com',role:'editor'}}),user=added.member.user_id;
  const api=(url,options={})=>f.api(url,{user,...options}),request=(url,options={})=>f.request(url,{user,...options});
  const members=()=>f.api(`/api/companies/${a.company.id}/members`);
  const grant=(await members()).members[0].grant_id;
  const set=scopes=>f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes}});
  const paths=[`/api/companies/${a.company.id}/ssh`,`/api/projects/${a.project.id}/github`,`/api/boards/${a.project.id}/environment`,`/api/boards/${a.project.id}/payments`,`/api/companies/${a.company.id}/members`];
  for(const url of paths)assert.equal((await request(url)).status,403,url);
  assert.deepEqual((await api(`/api/projects/${a.project.id}/permissions`)).scopes,[]);
  assert.equal((await f.request(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['root']}})).status,400);
  await set(all);
  assert.deepEqual((await api(`/api/projects/${a.project.id}/permissions`)).scopes,all);
  assert.deepEqual((await api(`/api/projects/${sibling.id}/permissions`)).scopes,all);
  for(const url of paths)assert.equal((await request(url)).status,200,url);
  for(const url of [`/api/companies/${b.company.id}/ssh`,`/api/projects/${b.project.id}/github`,`/api/boards/${b.project.id}/environment`,`/api/boards/${b.project.id}/payments`,`/api/companies/${b.company.id}/members`])assert.ok([403,404].includes((await request(url)).status),url);
  await api(`/api/boards/${a.project.id}/environment/EXAMPLE_TOKEN`,{method:'PUT',body:{value:'synthetic-environment-secret'}});
  assert.ok(!JSON.stringify(await api(`/api/boards/${a.project.id}/environment`)).includes('synthetic-environment-secret'));
  const ssh=await api(`/api/companies/${a.company.id}/ssh`,{method:'POST',body:{label:'Synthetic connection',host:'127.0.0.1',port:22,username:'fixture',auth_type:'password',password:'synthetic-ssh-password',fingerprint:'SHA256:'+'a'.repeat(43),allow_agent:false}});
  assert.ok(!JSON.stringify(ssh).includes('synthetic-ssh-password'));
  assert.ok(!JSON.stringify(await api(`/api/projects/${a.project.id}/ssh`)).includes('synthetic-ssh-password'));
  // Members may manage cards, not the budget, checkout switch or purchase ledger.
  const payment=await api(`/api/boards/${a.project.id}/payments/cards`,{method:'POST',body:{label:'Fixture card',number:'4242424242424242',exp_month:12,exp_year:2035,cardholder:'Fixture Member',billing:{line1:'1 Example St',city:'Test',country:'US'}}});
  assert.ok(!JSON.stringify(payment).includes('4242424242424242'));
  assert.equal((await request(`/api/boards/${a.project.id}/payments`,{method:'PUT',body:{currency:'USD',budget_minor:99999999,allow_agent:true}})).status,403);
  assert.equal((await request(`/api/boards/${a.project.id}/payments/purchases/unknown/resolve`,{method:'POST',body:{status:'released'}})).status,403);
  // Delegates can manage ordinary members, but cannot pass on scopes, alter
  // privileged members, persist their own access or cross a company boundary.
  const ordinary=await api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'ordinary@example.com',role:'viewer'}});
  let ordinaryGrant=(await members()).members.find(m=>m.email==='ordinary@example.com').grant_id;
  await api(`/api/memberships/${ordinaryGrant}`,{method:'PATCH',body:{role:'editor'}});
  assert.equal((await request(`/api/memberships/${ordinaryGrant}`,{method:'PATCH',body:{scopes:['ssh']}})).status,403);
  assert.equal((await request(`/api/memberships/${grant}`,{method:'PATCH',body:{role:'viewer'}})).status,403);
  assert.equal((await request(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'editor@example.com',role:'editor'}})).status,403);
  // A verified alternate email for the same identity must not bypass self checks.
  f.users.find(u=>u.id===user).emailAddresses.push({emailAddress:'alias@example.com',verification:{status:'verified'}});
  assert.equal((await request(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'alias@example.com',role:'editor'}})).status,403);
  await f.api(`/api/memberships/${ordinaryGrant}`,{method:'PATCH',body:{scopes:['github']}});
  assert.equal((await request(`/api/memberships/${ordinaryGrant}`,{method:'DELETE'})).status,403);
  assert.equal((await request(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'ordinary@example.com',role:'viewer'}})).status,403);
  await set([]);
  for(const url of paths)assert.equal((await request(url)).status,403,url);
  // Viewer task permissions stay intact even with optional connector/member scopes.
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{role:'viewer',scopes:['environment','members']}});
  await api(`/api/boards/${a.project.id}/environment/VIEWER_TOKEN`,{method:'PUT',body:{value:'viewer-fixture'}});
  assert.equal((await request(`/api/lists/${a.list.id}/cards`,{method:'POST',body:{title:'Forbidden task edit'}})).status,403);
  assert.equal((await request(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'elevated@example.com',role:'editor'}})).status,403);
  await api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'viewer2@example.com',role:'viewer'}});
  // Project-only members are visible in the company owner's permission panel.
  const projectMember=await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'project@example.com',role:'editor'}});
  const projectGrant=(await members()).project_members.find(m=>m.email==='project@example.com');
  assert.equal(projectGrant.project_name,'Nasdo');
  await f.api(`/api/memberships/${projectGrant.grant_id}`,{method:'PATCH',body:{scopes:all}});
  const projectUser=projectMember.member.user_id;
  assert.deepEqual((await f.api(`/api/projects/${a.project.id}/permissions`,{user:projectUser})).scopes,all);
  assert.equal((await f.request(`/api/companies/${a.company.id}/ssh`,{user:projectUser})).status,403);
  assert.equal((await f.request(`/api/projects/${sibling.id}/ssh`,{user:projectUser})).status,403);
  await f.api(`/api/company-boards/${a.board.id}`,{method:'PATCH',body:{company_id:b.company.id}});
  assert.deepEqual((await f.api(`/api/projects/${a.project.id}/permissions`,{user:projectUser})).scopes,[],'Project move requires scope review before exposing a different company');
  assert.equal((await f.request(`/api/boards/${a.project.id}/environment`,{user:projectUser})).status,403);
  const moved=(await f.api(`/api/companies/${b.company.id}/members`)).project_members.find(m=>m.grant_id===projectGrant.grant_id);assert.equal(moved.scopes_need_review,true);
  await f.api(`/api/memberships/${projectGrant.grant_id}`,{method:'PATCH',body:{scopes:['environment']}});
  assert.equal((await f.request(`/api/boards/${a.project.id}/environment`,{user:projectUser})).status,200);
  assert.equal((await request(`/api/boards/${a.project.id}/environment`)).status,403,'Company scope does not follow a project out of company');
  console.log('PASS: default-off scopes, inheritance, hidden secrets, payment limits, delegated members, alias/self/privilege escalation prevention, project-only controls and company-move review');
 }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
