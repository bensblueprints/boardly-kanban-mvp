const assert=require('node:assert/strict');const {fixture}=require('./member-fixture');
(async()=>{let permission='none',calls=[],failWrite=false;const fake=async(token,route,options={})=>{calls.push({route,...options});if(route.includes('/git/ref/heads/'))return {object:{sha:'a'.repeat(40)}};if(route==='/repos/acme/product')return {full_name:'acme/product',permissions:{admin:true},owner:{type:'Organization'}};if(route==='/users/teammate')return {login:'teammate'};if(route.endsWith('/permission'))return {permission};if(options.method==='PUT'){if(failWrite)throw Object.assign(Error('Network uncertain'),{status:502});return {id:42};}return {login:'owner'};};const f=await fixture({publicAccess:true,githubRequest:fake,openWebUIRequest:async(c,p,b)=>p==='/api/models'?Response.json({data:[{id:'tools-model'}]}):Response.json({choices:[{message:b.messages.some(m=>m.role==='tool')?{content:'Review prepared. Confirm it in GitHub settings.'}:{content:null,tool_calls:[{id:'review-call',type:'function',function:{name:'github_access_review',arguments:JSON.stringify({username:'teammate',role:'pull'})}}]}}]})});const base='/api/account/github/access';try{
 await f.api('/api/account/github',{method:'PUT',body:{token:'github_fixture_private_token_123456'}});
 const body={repository:'acme/product',username:'teammate',role:'pull'};
 const review=await f.api(base+'/preview',{method:'POST',body});assert.equal(review.status,'pending');assert.equal(calls.filter(c=>c.method==='PUT').length,0);
 assert.equal((await f.request(base+'/'+review.id+'/confirm',{method:'POST',body:{}})).status,400);
 const key=(await f.api('/api/connections',{method:'POST',body:{name:'Approval denial fixture',scope:'mcp'}})).token;
 const mr=await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'call_api_operation',arguments:{operation_id:'POST /api/account/github/access/:id/confirm',parameters:{id:review.id},body:{confirmed:true}}}})});
 const mt=await mr.text(),event=mt.split('\n').find(s=>s.startsWith('data: ')),md=JSON.parse(event?event.slice(6):mt);assert.ok(md.result.isError,'Agent token cannot confirm');assert.equal(calls.filter(c=>c.method==='PUT').length,0);
 const result=await f.api(base+'/'+review.id+'/confirm',{method:'POST',body:{confirmed:true}});assert.equal(result.result.status,'invitation_pending');assert.equal(calls.filter(c=>c.method==='PUT').length,1);
 await f.api(base+'/'+review.id+'/confirm',{method:'POST',body:{confirmed:true}});assert.equal(calls.filter(c=>c.method==='PUT').length,1);
 const stale=await f.api(base+'/preview',{method:'POST',body});permission='push';assert.equal((await f.request(base+'/'+stale.id+'/confirm',{method:'POST',body:{confirmed:true}})).status,409);
 const next=await f.api(base+'/preview',{method:'POST',body});failWrite=true;assert.equal((await f.request(base+'/'+next.id+'/confirm',{method:'POST',body:{confirmed:true}})).status,502);assert.equal((await f.request(base+'/'+next.id+'/confirm',{method:'POST',body:{confirmed:true}})).status,409);
 const project=await f.project(),member=(await f.api(`/api/companies/${project.company.id}/members`,{method:'POST',body:{email:'member@example.com'}})).member.user_id;
 assert.equal((await f.request(base+'/preview',{user:member,workspace:'user_owner',method:'POST',body})).status,403);
 assert.equal((await f.api(base,{user:'user_other'})).reviews.length,0);
 await f.api('/api/account/ai-providers/openwebui',{method:'PUT',body:{base_url:'https://models.example.com',token:'fixture-key'}});
 await f.api('/api/account/ai-providers/openwebui/activate',{method:'POST'});
 await f.api(`/api/projects/${project.project.id}/github`,{method:'PUT',body:{repository:'acme/product',branch:'main',credential_source:'account',allow_agent:true}});
 const thread=await f.api(`/api/boards/${project.project.id}/chat/threads`,{method:'POST',body:{}});
 const writes=calls.filter(c=>c.method==='PUT').length;
 await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Prepare a read access invitation for teammate, wait for my confirmation'}});
 let done;for(let i=0;i<200;i++){done=await f.api(`/api/chat/threads/${thread.id}`);if(done.job&&!['queued','running'].includes(done.job.status))break;await new Promise(r=>setTimeout(r,15));}
 assert.equal(done.job.status,'completed',JSON.stringify(done.job));assert.equal(calls.filter(c=>c.method==='PUT').length,writes,'Agent only prepares a review');assert.ok((await f.api(base)).reviews.some(r=>r.status==='pending'));
 for(const extra of [{repository:'acme/product/../secrets'},{username:'../../admin'},{role:'owner'}])assert.equal((await f.request(base+'/preview',{method:'POST',body:{...body,...extra}})).status,400);
 console.log('PASS: GitHub invitation review, explicit confirmation, pending receipt, repeat suppression, access drift, uncertain write protection, member/account isolation and input validation.');
}finally{await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
