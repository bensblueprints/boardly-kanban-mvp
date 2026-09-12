const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
const answer=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const call=(name,args)=>({type:'function_call',id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),name,arguments:JSON.stringify(args)});
(async()=>{
 let companyA,companyB,phase='rules',seen=[],hold;
 const fake=async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const payload=JSON.parse(opts.body);seen.push(payload);const latest=payload.input.filter(x=>x.type==='function_call_output').at(-1);
  let output;
  if(!latest)output=[call('list_companies',{})];
  else if(!payload.input.some(x=>x.name==='inspect_company'))output=[call('inspect_company',{company_id:companyA})];
  else if(!payload.input.some(x=>x.name==='propose_setting_change'))output=[call('propose_setting_change',{company_id:companyA,type:phase==='rules'?'rules':phase==='rename'?'company':phase==='bad'?'storage':'skill',target_id:null,changes_json:JSON.stringify(phase==='rules'?{instructions:'Always ask before publishing.'}:phase==='rename'?{name:'Renamed by Master'}:phase==='bad'?{secret_key:'not-allowed'}:{name:'editorial-review',description:'Before publishing',instructions:'Check facts and obtain approval.',enabled:true}),summary:'Update the selected company setting after review.'})];
  else {if(phase==='wait')await new Promise(r=>hold=r);output=[answer('I prepared the change. Review it below and press Apply changes.')];}
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,output_tokens:20},output});
 };
 const f=await fixture({publicAccess:true,providerRequest:fake});
 try{
  const a=await f.project('Master A','Project A'),b=await f.project('Master B','Project B');companyA=a.company.id;companyB=b.company.id;
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:20,api_key:'sk-fixture_'+crypto.randomUUID()}});
  const t=await f.api('/api/master-chat/threads',{method:'POST',body:{}});
  async function send(text){const client_id=crypto.randomUUID();await f.api(`/api/master-chat/threads/${t.id}/messages`,{method:'POST',body:{content:text,client_id}});await f.api(`/api/master-chat/threads/${t.id}/messages`,{method:'POST',body:{content:text,client_id}});let chat;for(let i=0;i<150;i++){chat=await f.api('/api/master-chat/threads/'+t.id);if(!chat.turns.some(x=>['queued','running'].includes(x.status)))return chat;await new Promise(r=>setTimeout(r,15));}throw Error('Master Chat timed out');}
  let chat=await send('Set the publishing rule for Master A.');assert.equal(chat.turns.length,1,'Message request is idempotent');assert.equal(chat.turns[0].status,'completed',JSON.stringify(chat));let change=chat.turns[0].changes[0];assert.ok(change,JSON.stringify(chat));
  assert.equal((await f.api(`/api/companies/${companyA}/skills`)).rules.instructions,'','Proposing does not mutate settings');
  assert.equal((await f.request('/api/master-chat/changes/'+change.id+'/apply',{method:'POST',body:{}})).status,400);
  await f.api('/api/master-chat/changes/'+change.id+'/apply',{method:'POST',body:{reviewed:true}});await f.api('/api/master-chat/changes/'+change.id+'/apply',{method:'POST',body:{reviewed:true}});
  assert.equal((await f.api(`/api/companies/${companyA}/skills`)).rules.instructions,'Always ask before publishing.');assert.equal((await f.api(`/api/companies/${companyB}/skills`)).rules.instructions,'');
  phase='rename';chat=await send('Rename company A.');change=chat.turns.at(-1).changes[0];await f.api('/api/companies/'+companyA,{method:'PATCH',body:{name:'Changed in another window'}});assert.equal((await f.request('/api/master-chat/changes/'+change.id+'/apply',{method:'POST',body:{reviewed:true}})).status,409);assert.equal((await f.api('/api/hierarchy')).companies.find(c=>c.id===companyA).name,'Changed in another window');
  phase='skill';chat=await send('Save editorial-review as a skill.');change=chat.turns.at(-1).changes[0];assert.ok(change,JSON.stringify(chat));await f.api('/api/master-chat/changes/'+change.id+'/apply',{method:'POST',body:{reviewed:true}});assert.equal((await f.api(`/api/companies/${companyA}/skills`)).skills[0].name,'editorial-review');
  phase='bad';chat=await send('Try an unsupported credential field.');assert.equal(chat.turns.at(-1).changes.length,0);assert.ok(JSON.stringify(seen.at(-1)).includes('unsupported fields'));
  const editor=(await f.api(`/api/companies/${companyA}/members`,{method:'POST',body:{email:'master-editor@fixture.example',role:'editor'}})).member.user_id;
  for(const route of ['/api/master-chat/threads','/api/master-chat/threads/'+t.id])assert.equal((await f.request(route,{user:editor,workspace:'user_owner'})).status,403);
  assert.equal((await f.request('/api/master-chat/changes/'+change.id+'/apply',{user:editor,workspace:'user_owner',method:'POST',body:{reviewed:true}})).status,403);
  assert.equal((await f.request('/api/master-chat/threads/'+t.id,{user:'user_other'})).status,404);assert.equal((await f.api('/api/master-chat/threads',{user:'user_other'})).threads.length,0);
  assert.ok(JSON.stringify(seen).includes('Master B'),'Master Chat can inspect all owner companies');assert.ok(!JSON.stringify(seen).includes('sk-fixture_'));
  console.log('PASS: Master Chat tool loop, account-owner scope, cross-company context, real settings/skill writes after review, no mutation during proposal, message/apply idempotency, stale preview rejection, credential-field rejection and isolated saved history');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
