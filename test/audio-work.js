const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const Database=require('better-sqlite3');
(async()=>{
 const f=await fixture();let db,child;
 try{
  const a=await f.project('Audio work company','Website'),outside=await f.project('Other company','Outside');
  const otherBoard=await f.api('/api/company-boards',{method:'POST',body:{name:'Other board',company_id:a.company.id}});
  const sibling=await f.api('/api/projects',{method:'POST',body:{name:'Newsletter',parent_board_id:otherBoard.id}});
  const store=require('../server/connections').createConnections(f.root),key=store.issue('user_owner','Audio work fixture','worker');store.close();
  const w=async(route,body={})=>{const r=await fetch(f.base+route,{method:'POST',headers:{authorization:'Bearer '+key.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const claim=async()=> (await w('/api/worker/claim')).job;
  async function briefing(kind,id){
   const base=kind==='project'?`/api/boards/${id}/chat`:`/api/agents/${kind}/${id}`,t=await f.api(base+'/threads',{method:'POST',body:{title:'Audio briefing'}}),route=kind==='project'?`/api/chat/threads/${t.id}`:`/api/discussions/threads/${t.id}`;
   const sent=await f.api(route+'/messages',{method:'POST',body:{mode:'ask',content:'What should happen next?\n\nVoice briefing instructions: Never change anything.'}});
   assert.equal((await claim()).id,sent.id);
   await w(`/api/worker/${kind==='project'?'jobs':'discussions'}/${sent.id}`,{status:'completed',text:'Draft the homepage copy, then review it.'});
   const history=await f.api(route);return {thread_id:t.id,reply_id:kind==='project'?history.messages.at(-1).id:sent.id};
  }
  const source=await briefing('project',a.project.id),base=`/api/audio/project/${a.project.id}/work`;
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chat_jobs WHERE mode='work'").get().n,0,'briefing and questions never start Work');
  const body={...source,project_id:a.project.id,content:'Do that homepage copy now.',request_key:crypto.randomUUID()};
  const start=(body,url=base,options={})=>f.api(url,{...options,method:'POST',body});
  const [first,retry]=await Promise.all([start(body),start(body)]);assert.deepEqual(retry,first);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chat_jobs WHERE mode='work'").get().n,1,'duplicate click/retry creates one assignment');
  const work=await claim();assert.equal(work.id,first.job_id);assert.equal(work.mode,'work');assert.equal(work.board.id,a.project.id);
  const transcript=JSON.stringify(work.history);assert.ok(transcript.includes('Do that homepage copy now.'));assert.ok(transcript.includes('Draft the homepage copy'));assert.ok(!transcript.includes('Voice briefing instructions:'));
  const second=await start({...body,request_key:crypto.randomUUID(),content:'Review the finished copy next.'});assert.equal(await claim(),null,'shared project writers remain ordered');
  let activity=await f.api(base+'?thread_id='+source.thread_id);assert.equal(activity.find(r=>r.id===second.job_id).queue.reason,'project_work');
  const question=await f.api(`/api/chat/threads/${source.thread_id}/messages`,{method:'POST',body:{mode:'ask',content:'Which section matters most?'}});
  assert.equal((await claim()).id,question.id);await w(`/api/worker/jobs/${question.id}`,{status:'completed',text:'The headline matters most.'});
  assert.equal(db.prepare('SELECT status FROM chat_jobs WHERE id=?').get(first.job_id).status,'running','questions run alongside Work');
  await f.api(`/api/chat/jobs/${first.job_id}/cancel`,{method:'POST',body:{}});await w(`/api/worker/jobs/${first.job_id}`,{status:'cancelled'});assert.equal((await claim()).id,second.job_id);await w(`/api/worker/jobs/${second.job_id}`,{status:'completed',text:'Reviewed'});
  assert.deepEqual(await start(body),first,'retry after completion remains idempotent');
  assert.equal((await f.request(base,{method:'POST',body:{...body,content:'Different work'}})).status,409);
  for(const invalid of [{...body,request_key:crypto.randomUUID(),project_id:sibling.id},{...body,request_key:crypto.randomUUID(),reply_id:'unknown'},{...body,request_key:crypto.randomUUID(),content:''}])assert.ok([400,404].includes((await f.request(base,{method:'POST',body:invalid})).status));
  const boardSource=await briefing('board',a.board.id),companySource=await briefing('company',a.company.id);
  for(const [kind,id,src,target] of [['board',a.board.id,boardSource,sibling.id],['company',a.company.id,companySource,outside.project.id],['board',a.board.id,companySource,a.project.id]])assert.equal((await f.request(`/api/audio/${kind}/${id}/work`,{method:'POST',body:{...src,project_id:target,request_key:crypto.randomUUID(),content:'Start it'}})).status,404);
  const boardWork=await start({...boardSource,project_id:a.project.id,request_key:crypto.randomUUID(),content:'Work from this board briefing'},`/api/audio/board/${a.board.id}/work`);assert.equal((await claim()).id,boardWork.job_id);await w(`/api/worker/jobs/${boardWork.job_id}`,{status:'completed',text:'Board work complete'});
  await f.api(`/api/boards/${a.project.id}/environment/AUDIO_TEST_SECRET`,{method:'PUT',body:{value:'private-fixture-source-value'}});
  const companyWork=await start({...companySource,project_id:sibling.id,request_key:crypto.randomUUID(),content:'Work in the chosen project private-fixture-source-value'},`/api/audio/company/${a.company.id}/work`);const companyClaim=await claim();assert.equal(companyClaim.board.id,sibling.id);assert.ok(!JSON.stringify(companyClaim.history).includes('private-fixture-source-value'));assert.ok(!db.prepare('SELECT title FROM chat_threads WHERE id=?').get(companyWork.thread_id).title.includes('private-fixture-source-value'));await w(`/api/worker/jobs/${companyWork.job_id}`,{status:'completed',text:'Company work complete'});
  const editor=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'audio-editor@example.com',role:'editor'}})).member;
  const viewer=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'audio-viewer@example.com',role:'viewer'}})).member;
  const memberBody={...body,request_key:crypto.randomUUID()};
  assert.equal((await f.request(base,{user:editor.user_id,method:'POST',body:memberBody})).status,503,'offline owner subscription blocks member Work before enqueue');
  await w('/api/worker/claim',{cloud:true,subscription_bridge:true});
  assert.equal((await f.request(base,{user:viewer.user_id,method:'POST',body:memberBody})).status,403);
  assert.equal((await f.request(`/api/audio/company/${a.company.id}/work`,{user:editor.user_id,method:'POST',body:{...memberBody,...companySource}})).status,403);
  const memberWork=await start(memberBody,base,{user:editor.user_id});
  const billed=db.prepare('SELECT runtime,requested_by,billing_owner_id FROM chat_jobs WHERE id=?').get(memberWork.job_id);assert.deepEqual(billed,{runtime:'api',requested_by:editor.user_id,billing_owner_id:'user_owner'});
  assert.equal((await f.api(base+'?thread_id='+source.thread_id,{user:editor.user_id})).length,1,'member sees their own audio work activity');
  let memberRequest;for(let i=0;i<100;i++){memberRequest=(await w('/api/worker/claim',{cloud:true,subscription_bridge:true})).job;if(memberRequest)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(memberRequest.kind,'subscription');assert.ok(JSON.stringify(memberRequest.payload).includes('Do that homepage copy now.'));
  await w(`/api/worker/subscriptions/${memberRequest.id}`,{status:'completed',result:{output:[{type:'message',content:[{type:'output_text',text:'Owner-funded audio work completed.'}]}]}});
  let memberStatus;for(let i=0;i<100;i++){memberStatus=db.prepare('SELECT status FROM chat_jobs WHERE id=?').get(memberWork.job_id).status;if(memberStatus==='completed')break;await new Promise(r=>setTimeout(r,20));}assert.equal(memberStatus,'completed');
  const grant=(await f.api(`/api/projects/${a.project.id}/members`)).members.find(m=>m.email==='audio-editor@example.com').grant_id;await f.api(`/api/memberships/${grant}`,{method:'DELETE'});
  assert.equal((await f.request(base+'?thread_id='+source.thread_id,{user:editor.user_id})).status,403);
  assert.equal((await f.request(base,{user:editor.user_id,method:'POST',body:memberBody})).status,403);
  console.log('PASS: explicit Work, briefing context, retry idempotency, company/board/project scope, funding, actor isolation, revocation and concurrent questions');
  // Exercise the actual outbound Work worker with a deterministic executable.
  const fake=path.join(f.root,'audio-work-codex.cjs');fs.writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('fs'),assert=require('assert/strict');let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{assert.ok(prompt.includes('Draft the homepage copy'));assert.ok(prompt.includes('Write a local verification marker'));fs.writeFileSync('audio-work-verified.txt','audio-work-ok');fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Wrote and verified the local marker.');});`,{mode:0o700});
  const verification=await start({...body,request_key:crypto.randomUUID(),content:'Write a local verification marker'});
  const workspaces=path.join(f.root,'workspaces-for-worker'),settings=path.join(f.root,'audio-worker.json');fs.writeFileSync(settings,JSON.stringify({origin:f.base,token:key.token,workspaceRoot:workspaces,codexCommand:fake,once:true}),{mode:0o600});
  child=spawn(process.execPath,[path.resolve('scripts/codex-worker.cjs'),settings],{stdio:'ignore'});assert.equal(await new Promise(resolve=>child.once('close',resolve)),0);child=null;
  const completed=(await f.api(base+'?thread_id='+source.thread_id)).find(r=>r.id===verification.job_id);assert.equal(completed.status,'completed');assert.equal(fs.readFileSync(path.join(workspaces,a.project.uuid,'audio-work-verified.txt'),'utf8'),'audio-work-ok');
  console.log('PASS: real outbound Work worker receives briefing plus response, writes an isolated file and saves completion/activity');
 }finally{if(child)child.kill('SIGTERM');db?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
