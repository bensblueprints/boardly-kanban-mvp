const assert=require('node:assert/strict'),{fixture}=require('./member-fixture');
(async()=>{
 const calls=[];
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:['org','company','department','board'].map(id=>({id}))});
  const body=JSON.parse(options.body);calls.push({body,key:options.headers.Authorization});
  return Response.json({choices:[{message:{content:'OK'}}]});
 }});
 const put=(path,body)=>f.api(path,{method:'PUT',body}),select=(path,model,source='organization')=>put(path,{source,provider:'deepseek',model});
 async function completed(path){for(let i=0;i<100;i++){const d=await f.api(path);if(d.job&&!['queued','running'].includes(d.job.status))return d;await new Promise(r=>setTimeout(r,20));}throw Error('Work timed out');}
 try{
  const a=await f.project('Company A','Board A'),b=await f.project('Company B','Board B');
  const c=`/api/companies/${a.company.id}/ai`,d=`/api/departments/${a.board.id}/ai`,p=`/api/projects/${a.project.id}/ai`;
  const other=await f.api('/api/projects',{method:'POST',body:{name:'Sibling',parent_board_id:a.board.id}}),sibling=`/api/projects/${other.id}/ai`;
  await put('/api/account/ai-providers/deepseek',{token:'org-fixture-key',model:'org'});await f.api('/api/account/ai-providers/deepseek/activate',{method:'POST'});
  assert.equal((await f.api(p)).effective.model,'org');
  await select(c,'company');assert.equal((await f.api(p)).effective.model,'company');
  await select(d,'department');assert.equal((await f.api(p)).effective.model,'department');
  assert.equal((await f.api(p)).effective.inherited_from.kind,'department');
  await select(p,'board');assert.equal((await f.api(sibling)).effective.model,'department');
  assert.equal((await f.api(c)).effective.model,'company');assert.equal((await f.api('/api/ai/settings')).model,'org');
  const ping=await f.api(p+'/test',{method:'POST',body:{source:'inherit'}});assert.equal(ping.model,'department');assert.equal(ping.ok,true);assert.equal((await f.api(p)).effective.model,'board','Unsaved inherit test leaves saved override intact');
  const t=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Report status.'}});
  assert.equal((await completed('/api/chat/threads/'+t.id)).job.status,'completed');assert.equal(calls.at(-1).body.model,'board');
  await put(p,{source:'inherit'});assert.equal((await f.api(p)).effective.model,'department');
  await put(d,{source:'inherit'});assert.equal((await f.api(p)).effective.model,'company');
  await put(c+'/providers/deepseek',{token:'company-a-fixture-key'});await select(d,'department','company');
  await f.api(p+'/test',{method:'POST',body:{source:'inherit'}});assert.equal(calls.at(-1).key,'Bearer company-a-fixture-key');
  await f.api(`/api/company-boards/${a.board.id}`,{method:'PATCH',body:{company_id:b.company.id}});
  assert.match((await f.api(p)).effective.error,/moved/);const count=calls.length;
  assert.equal((await f.request(p+'/test',{method:'POST',body:{source:'inherit'}})).status,409);assert.equal(calls.length,count,'Moving to a different Company cannot reuse the old private connection');
  await put(d,{source:'inherit'});assert.equal((await f.api(p)).effective.model,'org');
  const member=(await f.api(`/api/companies/${b.company.id}/members`,{method:'POST',body:{email:'member@scoped.test'}})).member.user_id;
  for(const path of [d,p]){
   assert.equal((await f.request(path,{user:member,workspace:'user_owner'})).status,403);
   assert.equal((await f.request(path,{user:member,workspace:'user_owner',method:'PUT',body:{source:'inherit'}})).status,403);
   assert.equal((await f.request(path+'/test',{user:member,workspace:'user_owner',method:'POST',body:{source:'inherit'}})).status,403);
   assert.equal((await f.request(path,{user:'user_foreign'})).status,404);
   assert.equal((await f.request(path,{method:'PUT',body:{source:'organization',provider:'deepseek',model:'missing'}})).status,400);
  }
  await f.api(`/api/company-boards/${a.board.id}`,{method:'PATCH',body:{company_id:null}});assert.equal((await f.api(d)).parent.scope.kind,'organization');
  assert.equal((await f.request(d,{method:'PUT',body:{source:'company',provider:'deepseek',model:'department'}})).status,400);
  console.log('PASS: Organization > Company > Department > Board model precedence, inherited model ping, real Board work, sibling isolation, reset, moved credentials and owner permissions.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
