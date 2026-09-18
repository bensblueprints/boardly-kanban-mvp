const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const {createOnePassword}=require('../server/onepassword');
const {createComputerUseConnections}=require('../server/computeruse-connections');
(async()=>{
 const token='ops_fixture_not_a_real_token',secret='fixture-password-sensitive',ref='op://'+'a'.repeat(26)+'/'+'b'.repeat(26)+'/password',desktopId=crypto.randomUUID();
 let resolve=async()=>secret;
 const client=async t=>{assert.equal(t,token);return {vaults:{list:async()=>[{id:'a'.repeat(26),title:'Automation',private:secret}]},items:{list:async()=>[{id:'b'.repeat(26),category:'Login',title:'Example login',websites:[{url:'https://example.com/login?private=not-returned'}],private:secret}]},secrets:{resolve:r=>{assert.equal(r,ref);return resolve();}}};};
 const account={id:'fixture-account',rentals:[],desktops:[{id:desktopId,kind:'pilot',state:'active',available:true,memory_mib:6144,label:'Fixture',vcpus:4,disk_gib:100}]};
 const f=await fixture({publicAccess:true,onepasswordClient:client,computeruseOrigin:'https://computeruse.example',computeruseRequest:async()=>account});let db;
 try{
  const p=await f.project(),other=await f.project('Other','Other'),base='/api/account/onepassword';
  assert.equal((await f.request(base,{method:'PUT',body:{token:'wrong'}})).status,400);
  const connected=await f.api(base,{method:'PUT',body:{token}});assert.equal(connected.saved,true);assert.ok(!JSON.stringify(connected).includes(token));
  const vaults=await f.api(base+'/vaults'),items=await f.api(base+'/vaults/'+'a'.repeat(26)+'/items');assert.ok(!JSON.stringify([vaults,items]).includes(secret));assert.deepEqual(items.items[0].origins,['https://example.com']);
  assert.equal((await f.request(base+'/logins',{method:'POST',body:{label:'Bad',url:'http://example.com',password_ref:ref}})).status,400);
  const result=await f.api(base+'/logins',{method:'POST',body:{label:'Example login',url:'https://example.com/login',password_ref:ref}}),id=result.logins[0].id;
  await f.api(`/api/companies/${p.company.id}/onepassword`,{method:'PUT',body:{login_ids:[id]}});
  const inherited=await f.api(`/api/projects/${p.project.id}/onepassword`);assert.deepEqual(inherited.inherited_ids,[id]);
  const another=await f.api(base,{user:'user_other'});assert.equal(another.saved,false);assert.deepEqual(another.logins,[]);
  await f.api(`/api/companies/${p.company.id}/members`,{method:'POST',body:{email:'member@example.com',role:'editor'}});
  const member=f.users.at(-1).id;
  assert.equal((await f.request(base,{user:member,workspace:'user_owner'})).status,403);
  assert.equal((await f.request(`/api/projects/${p.project.id}/onepassword`,{user:member,workspace:'user_owner',method:'PUT',body:{login_ids:[id]}})).status,403);
  await f.api('/api/account/computeruse',{method:'PUT',body:{token:'cu_fixture_key_123456789012345'}});
  await f.api(`/api/projects/${p.project.id}/computeruse`,{method:'PUT',body:{rental_ids:['desktop:'+desktopId],allow_agent:true,allow_control:true}});
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));db.pragma('foreign_keys=ON');const key=fs.readFileSync(path.join(f.root,'project-secrets.key'));
  const vault=createOnePassword({db,key,namespace:'user_owner',client});assert.equal(vault.forAgent(other.project.id).length,0);
  assert.ok(!JSON.stringify(vault.forAgent(p.project.id)).includes('op://'));
  const encrypted=db.prepare('SELECT encrypted FROM op_connection').get().encrypted;assert.ok(!encrypted.includes(token));
  let sent=[],human=false;
  const cu=createComputerUseConnections({db,key,namespace:'user_owner',origin:'https://computeruse.example',request:async()=>account,onepassword:vault,desktopRequest:async(o,t,cmd,args)=>{
   if(human&&cmd==='lease')throw Object.assign(Error('Human control active'),{status:409});
   if(cmd==='lease')return {lease:'fixture-lease',expires:Math.floor(Date.now()/1000)+60};
   if(cmd==='screenshot')return {image_url:'data:image/jpeg;base64,/9j/2Q=='};
   if(cmd==='login'){assert.equal(args.login.origin,'https://example.com');if(args.login.mode==='fill')assert.equal(args.login.value,secret);sent.push(cmd);}
   return {state:'completed'};
  }});
  const run=(mode,extra={})=>cu.controlForAgent(p.project.id,member,'run-one','login',{desktop_id:desktopId,login_id:id,operation_id:crypto.randomUUID(),mode,field:'password',...extra});
  await run('open');const filled=await run('fill');assert.equal(filled.state,'filled');assert.ok(!JSON.stringify(filled).includes(secret));assert.equal(filled.submitted,false);
  const n=sent.length;human=true;await assert.rejects(()=>run('fill'),/Human control/);assert.equal(sent.length,n);human=false;
  resolve=async()=>{vault.assign('company',p.company.id,[]);return secret;};await assert.rejects(()=>run('fill'),/access changed/);assert.equal(sent.length,n);
  assert.ok(!JSON.stringify(vault.summary()).includes(secret));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM op_audit').all()).includes(secret));
  vault.assign('company',p.company.id,[id]);await f.api(base+'/logins/'+id,{method:'DELETE'});assert.equal(vault.forAgent(p.project.id).length,0);
  await f.api(base,{method:'DELETE'});assert.equal(vault.summary().saved,false);
  console.log('PASS: 1Password encrypted credentials, tenant/member isolation, explicit/inherited login grants, secret-free results/audit, human takeover and mid-resolution revocation.');
 }finally{db?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
