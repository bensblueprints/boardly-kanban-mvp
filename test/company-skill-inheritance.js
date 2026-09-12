const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
(async()=>{
 const seen=[],secret='synthetic-ssh-password-'+crypto.randomUUID();
 const f=await fixture({publicAccess:true,providerRequest:async(url,options)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const body=JSON.parse(options.body);seen.push(body);const context=body.input.find(i=>i.content?.startsWith('Current saved GitHub connection:'));
  assert.ok(body.input.some(x=>x.content?.startsWith('COMPANY RULES AND SKILLS:')&&x.content.includes('COMPANY_A_ONLY_RULE')));assert.ok(!JSON.stringify(body).includes('COMPANY_B_PRIVATE_RULE'));assert.ok(context?.content.includes('Shared Hetzner'),'Hosted chat receives durable account SSH context');assert.ok(!JSON.stringify(body).includes(secret));
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Hetzner is shared from your account. Work mode can use it.'}]}]});
 }});
 try{
  const a=await f.project('Company A','Project A');
  const skillBase=`/api/companies/${a.company.id}/skills`;
  await f.api(skillBase+'/rules',{method:'PUT',body:{instructions:'COMPANY_A_ONLY_RULE: verify results before completion.',revision:null}});
  await f.api(skillBase,{method:'POST',body:{name:'company-a-workflow',description:'For company A work',instructions:'COMPANY_A_ONLY_SKILL: keep task checklists current.',enabled:true}});
  const connection=await f.api('/api/account/ssh',{method:'POST',body:{label:'Shared Hetzner',host:'ssh.example.test',port:22,username:'deploy',auth_type:'password',password:secret,fingerprint:'SHA256:'+'a'.repeat(43),allow_agent:true}});
  const b=await f.project('Future Company','Future Project');
  await f.api(`/api/companies/${b.company.id}/skills/rules`,{method:'PUT',body:{instructions:'COMPANY_B_PRIVATE_RULE',revision:null}});
  const context=id=>`/api/boards/${id}/chat/context`;
  for(const p of [a,b]){const c=(await f.api(context(p.project.id))).ssh;assert.equal(c.connections[0].id,connection.id);assert.equal(c.connections[0].source,'account');assert.equal(c.status,'ready');assert.ok(!JSON.stringify(c).includes(secret));assert.ok(!JSON.stringify(c).includes('encrypted'));}
  const member=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'member@example.com',role:'editor'}})).member.user_id,m={user:member,workspace:'user_owner'};
  assert.equal((await f.api(context(a.project.id),m)).ssh.status,'restricted');assert.ok(!JSON.stringify(await f.api(context(a.project.id),m)).includes('ssh.example.test'));
  const grant=(await f.api(`/api/projects/${a.project.id}/members`)).members[0].grant_id;
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{owner_ssh:true}});assert.equal((await f.api(context(a.project.id),m)).ssh.connections[0].id,connection.id);
  assert.equal((await f.request(context(b.project.id),m)).status,404);
  await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{owner_ssh:false}});assert.equal((await f.api(context(a.project.id),m)).ssh.status,'restricted');
  const other=(await f.api(context((await f.project('Member own company','Own project',member)).project.id),{user:member})).ssh;assert.equal(other.saved,false,'Separate owner account cannot see inherited connection');
  const workerKey=await f.api('/api/connections',{method:'POST',body:{name:'SSH context test',scope:'worker'}});
  const worker=async(route,body={})=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+workerKey.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const old=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{}});
  for(const mode of ['ask','plan','work']){
   const t=mode==='plan'?await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{}}):old;
   await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode,content:'Can this project use the account Hetzner connection?'}});
   const {job}=await worker('/api/worker/claim');assert.equal(job.mode,mode);const instructions=mode==='work'?job.company_instructions:job.context[0].company_instructions;assert.ok(JSON.stringify(instructions).includes('COMPANY_A_ONLY_SKILL'));assert.ok(!JSON.stringify(job).includes('COMPANY_B_PRIVATE_RULE'));const rows=mode==='work'?job.ssh:job.context[0].ssh.connections;
   assert.equal(rows[0].id,connection.id);assert.equal(rows[0].source,'account');assert.ok(!JSON.stringify(job).includes(secret));
   await worker(`/api/worker/jobs/${job.id}`,{status:'completed',text:'Shared connection exists.'});
  }
  const company=await f.api(`/api/agents/company/${a.company.id}/threads`,{method:'POST',body:{}});
  await f.api(`/api/discussions/threads/${company.id}/messages`,{method:'POST',body:{mode:'ask',content:'Which SSH connections are shared with our projects?'}});
  const discussion=(await worker('/api/worker/claim')).job;assert.equal(discussion.context.projects[0].ssh.connections[0].id,connection.id);assert.ok(JSON.stringify(discussion.context.company_instructions).includes('COMPANY_A_ONLY_RULE'));assert.ok(!JSON.stringify(discussion).includes('COMPANY_B_PRIVATE_RULE'));
  await worker(`/api/worker/discussions/${discussion.id}`,{status:'completed',text:'Shared Hetzner is saved.'});
  await f.api(`/api/account/ssh/${connection.id}`,{method:'PATCH',body:{allow_agent:false}});assert.equal((await f.api(context(a.project.id))).ssh.status,'paused');assert.equal((await f.api(`/api/projects/${a.project.id}/ssh`)).inherited[0].allow_agent,0);
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomUUID()}});
  for(const mode of ['ask','plan','work']){
   const t=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode,content:'Is my shared SSH connection still saved?'}});
   let h;for(let i=0;i<100;i++){h=await f.api(`/api/chat/threads/${t.id}`);if(!['queued','running'].includes(h.job.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(h.job.status,'completed',h.job.error);if(mode!=='work')assert.deepEqual(seen.at(-1).tools,[]);
  }
  assert.equal(seen.length,3);console.log('PASS: company rules and enabled skills reach native Ask/Plan/Work, company discussions and hosted API prompts without leaking another company’s instructions');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
