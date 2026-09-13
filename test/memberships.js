const assert=require('node:assert/strict');
const {fixture}=require('./member-fixture');
async function run(){
 const f=await fixture();try{
  const {api,request}=f,a=await f.project('Shared Co','Allowed'),b=await f.project('Private Co','Private');
  const card=await api(`/api/lists/${a.list.id}/cards`,{method:'POST',body:{title:'Shared task'}}),secretCard=await api(`/api/lists/${b.list.id}/cards`,{method:'POST',body:{title:'Private task'}});
  const grant=await api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'member@example.com',role:'editor'}}),member=grant.member.user_id;
  assert.ok((await api('/api/me',{user:member})).allowed);assert.equal((await api('/api/account/plan')).user_limit,null);
  await api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'member@example.com',role:'viewer'}});
  assert.equal((await api('/api/account/plan')).usage.users,2);
  const tree=await api('/api/hierarchy',{user:member});assert.deepEqual(tree.projects.map(p=>p.id),[a.project.id]);assert.equal(tree.owner,false);
  assert.equal((await api(`/api/boards/${a.project.id}`,{user:member})).permissions.role,'editor');
  await api(`/api/cards/${card.id}`,{user:member,method:'PATCH',body:{title:'Member edit'}});
  for(const route of [`/api/boards/${b.project.id}`,`/api/cards/${secretCard.id}`,`/api/companies/${a.company.id}/emails`,`/api/boards/${a.project.id}/environment`,`/api/boards/${a.project.id}/payments`,'/api/connections','/api/sync/status'])assert.ok([403,404].includes((await request(route,{user:member})).status),route);
  assert.equal((await request(`/api/cards/${card.id}/move`,{user:member,method:'POST',body:{list_id:b.list.id,position:0}})).status,404);
  assert.equal((await request('/api/boards',{user:member,workspace:'user_stranger'})).status,403);
  assert.equal((await request(`/api/boards/${a.project.id}/agent`,{user:member,method:'POST',body:{}})).status,503);
  const form=new FormData();form.set('file',new Blob(['member file'],{type:'text/plain'}),'shared.txt');const file=await api(`/api/boards/${a.project.id}/files`,{user:member,method:'POST',body:form});
  assert.equal(await(await request(`/api/project-files/${file.id}/download`,{user:member})).text(),'member file');
  const companyMembers=await api(`/api/companies/${a.company.id}/members`);await api(`/api/memberships/${companyMembers.members[0].grant_id}`,{method:'DELETE'});
  assert.equal((await api(`/api/boards/${a.project.id}`,{user:member})).permissions.role,'viewer');
  assert.equal((await request(`/api/cards/${card.id}`,{user:member,method:'PATCH',body:{title:'Forbidden'}})).status,403);
  assert.equal((await request(`/api/project-files/${file.id}`,{user:member,method:'DELETE'})).status,403);
  const direct=await api(`/api/projects/${a.project.id}/members`);await api(`/api/memberships/${direct.members[0].grant_id}`,{method:'DELETE'});
  assert.equal((await request(`/api/project-files/${file.id}/download`,{user:member})).status,403);assert.equal((await api('/api/account/plan')).usage.users,1);
  // Moving a board updates inherited access immediately; direct grants remain.
  await api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'member2@example.com',role:'editor'}});const member2=f.users.at(-1).id;
  await api(`/api/company-boards/${a.board.id}`,{method:'PATCH',body:{company_id:b.company.id}});assert.equal((await request(`/api/boards/${a.project.id}`,{user:member2})).status,404);
  console.log('PASS: company inheritance, direct grants, one seat per person, reserved email-code identities, viewer/editor controls, resource isolation, revocation and board moves');
 }finally{await f.close();}
 const p=await fixture({publicAccess:true});try{
  const a=await p.project('Basic company','Basic project','user_basic');
  const plan=await p.api('/api/account/plan',{user:'user_basic'});assert.equal(plan.user_limit,1);assert.equal(plan.plan.storage_bytes,2*1024**3);assert.equal(plan.extra_user_monthly_price,9);
  assert.equal((await p.request('/api/companies',{user:'user_basic',method:'POST',body:{name:'Over quota'}})).status,409);
  assert.equal((await p.request(`/api/projects/${a.project.id}/members`,{user:'user_basic',method:'POST',body:{email:'extra@example.com',role:'editor'}})).status,409);
  assert.deepEqual(plan.plans.map(x=>[x.monthly_price,x.companies,x.users,x.storage_bytes]),[[0,1,1,2*1024**3],[79,null,5,10*1024**3],[299,null,300,1024**4]]);
  assert.equal((await p.request('/api/billing/checkout',{user:'user_basic',method:'POST',body:{kind:'agency'}})).status,503);
  const db=new (require('better-sqlite3'))(require('node:path').join(require('../server/cloud').workspacePath(p.root,'user_basic'),'app.db'));
  db.prepare('INSERT INTO project_files(uuid,board_id,name,filename,size,mime,created_at) VALUES (?,?,?,?,?,?,?)').run(require('node:crypto').randomUUID(),a.project.id,'quota fixture','quota-fixture',2*1024**3-1,'text/plain',Date.now());
  const form=new FormData();form.set('file',new Blob(['too large'],{type:'text/plain'}),'over.txt');assert.equal((await p.request(`/api/boards/${a.project.id}/files`,{user:'user_basic',method:'POST',body:form})).status,413);
  const count=db.prepare('SELECT COUNT(*) n FROM boards').get().n;
  assert.equal((await p.request('/api/boards/import',{user:'user_basic',method:'POST',body:{app:'boardly',board:{name:'Over quota import'},lists:[{name:'List',cards:[{title:'Imported',attachments:[{original_name:'over.txt',data:Buffer.from('too large').toString('base64')}]}]}]}})).status,413);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM boards').get().n,count,'Over-quota import rolls back all rows');db.close();
  console.log('PASS: exact plan catalog, unlimited Ben account, Basic company/user/storage limits, import rollback and unavailable checkout fails closed');
 }finally{await p.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
