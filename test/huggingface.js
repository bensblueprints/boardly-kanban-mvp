const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path');const {fixture}=require('./member-fixture');
(async()=>{const token='hf_fixtureOnly123456789',f=await fixture({publicAccess:true,huggingFaceRequest:async(url,options)=>{assert.equal(url,'https://huggingface.co/api/whoami-v2');assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.redirect,'error');return Response.json({type:'user',name:'fixture-user',orgs:[{name:'test-org',roleInOrg:'admin'}]});}});try{
 const base='/api/account/huggingface';assert.equal((await f.api(base)).connected,false);
 const saved=await f.api(base,{method:'PUT',body:{token}});assert.equal(saved.username,'fixture-user');assert.equal(saved.organizations[0].name,'test-org');assert.ok(!JSON.stringify(saved).includes(token));
 assert.equal((await f.api(base,{user:'user_other'})).connected,false);
 await f.api(base+'/test',{method:'POST'});
 const p=await f.project(),member=(await f.api(`/api/companies/${p.company.id}/members`,{method:'POST',body:{email:'member@example.com'}})).member.user_id;assert.equal((await f.request(base,{user:member,workspace:'user_owner'})).status,403);
 await f.api(base,{method:'DELETE'});assert.equal((await f.api(base)).connected,false);assert.equal((await f.request(base+'/test',{method:'POST'})).status,409);
 console.log('PASS: Hugging Face verified account/org metadata, key masking, account/member isolation and disconnect.');
}finally{await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
