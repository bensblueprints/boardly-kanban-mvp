const assert=require('node:assert/strict'), crypto=require('node:crypto'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {createCloudApp,workspacePath}=require('../server/cloud');
const {createConnections}=require('../server/connections');
const {openDb}=require('../server/db');
const {createProjectEnvironment}=require('../server/project-environment');
const {createProjectPayments}=require('../server/project-payments');
const {createHierarchy}=require('../server/hierarchy');
const {createCompanyEmail,codes,publicAddress}=require('../server/company-email');
const {createEmailBroker}=require('../scripts/email-broker.cjs');
const {fillVerificationCode}=require('../scripts/company-email-client.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'boardly-company-test-'));
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const config={dataDir:root+'/cloud',origin:'https://boardly.example.com',ownerId:'user_owner',ownerOnly:false,planSlugs:['boardly_pro'],publishableKey:'pk_test_'+Buffer.from('boardly-test.clerk.accounts.dev$').toString('base64'),secretKey:'sk_test_fake',jwtKey:keys.publicKey.export({type:'spki',format:'pem'})};
function token(user){const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'test'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://boardly-test.clerk.accounts.dev',sub:user,sid:'test',iat:now,nbf:now-10,exp:now+600,azp:config.origin,v:2,fva:[0,-1],pla:'u:boardly_pro'})).toString('base64url'),u=h+'.'+p;return u+'.'+crypto.sign('RSA-SHA256',Buffer.from(u),keys.privateKey).toString('base64url');}
const secret='fixture-app-password-'+crypto.randomUUID(),code='739162',sent=new Date();
let beforeReturn=()=>{}, messages=[{uid:8,size:320,internalDate:sent,envelope:{subject:'Your sign-in verification code',from:[{address:'login@example.com'}]}}];
const connector=async(config,operation)=>{
 assert.equal(config.password,secret);
 const client={mailbox:{exists:messages.length,uidValidity:71},fetchAll:async()=>messages,
 fetchOne:async(uid,q)=>q.source?{source:Buffer.from(`From: login@example.com\r\nSubject: Your sign-in verification code\r\nContent-Type: text/plain\r\n\r\nYour verification code is ${code}.`)}:messages.find(m=>m.uid===Number(uid))};
 const result=await operation(client);await beforeReturn();return result;
};
let app,server,broker;
async function run(){
 // Simulate a real pre-hierarchy database and install the additive migration.
 let db=openDb(root+'/migration');
 const key=crypto.randomBytes(32),env=createProjectEnvironment({db,key,namespace:'fixture'}),payments=createProjectPayments({db,key,namespace:'fixture'});
 db.prepare('INSERT INTO boards(name) VALUES (?)').run('Existing board');db.prepare('INSERT INTO lists(board_id,name) VALUES (1,?)').run('In Progress');db.prepare('INSERT INTO cards(list_id,title) VALUES (1,?)').run('Existing task');
 const uuid=db.prepare('SELECT uuid FROM boards WHERE id=1').get().uuid;
 db.close();db=openDb(root+'/migration');
 let hierarchy=createHierarchy(db),tree=hierarchy.tree();assert.equal(tree.boards.length,1);assert.equal(tree.projects[0].id,1);assert.equal(tree.projects[0].name,'General');assert.equal(tree.projects[0].uuid,uuid);assert.equal(db.prepare('SELECT title FROM cards WHERE id=1').get().title,'Existing task');
 assert.deepEqual(hierarchy.tree(),tree);const co=hierarchy.createCompany({name:'Company A'});hierarchy.updateBoard(tree.boards[0].id,{company_id:co.id});assert.equal(hierarchy.scope(1).company_id,co.id);
 db.close();db=openDb(root+'/migration');hierarchy=createHierarchy(db);assert.equal(hierarchy.scope(1).company_id,co.id);db.close();
 console.log('PASS: additive migration preserves project/task IDs and UUIDs, General project wrapping, company moves and repeat-open persistence');
 const start=async()=>{app=createCloudApp(config,{emailConnector:connector});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return `http://127.0.0.1:${server.address().port}`;};let base=await start();
 const owner=token('user_owner'),customer=token('user_customer');
 const request=(route,method='GET',body,auth=owner)=>fetch(base+route,{method,headers:{...(auth?{authorization:'Bearer '+auth}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const api=async(...a)=>{const r=await request(...a),d=await r.json();assert.ok(r.ok,`${a[0]}: ${d.error}`);return d;};
 const a=await api('/api/companies','POST',{name:'Alpha'}),b=await api('/api/companies','POST',{name:'Beta'}),board=await api('/api/company-boards','POST',{company_id:a.id,name:'Operations'}),p=await api('/api/projects','POST',{parent_board_id:board.id,name:'Website'});
 assert.equal((await api(`/api/boards/${p.id}`)).lists.length,4);assert.equal((await api('/api/hierarchy')).projects[0].name,'Website');
 assert.equal((await request(`/api/company-boards/${board.id}`,'DELETE')).status,409);
 const mailbox=await api(`/api/companies/${a.id}/emails`,'POST',{label:'Operations',email:'ops@example.com',host:'mail.example.com',port:993,username:'ops@example.com',password:secret,allow_agent:true});
 await api(`/api/companies/${a.id}/emails`,'POST',{label:'Billing',email:'billing@example.com',host:'mail.example.com',port:993,username:'billing@example.com',password:secret});
 const betaMail=await api(`/api/companies/${b.id}/emails`,'POST',{label:'Private Beta',email:'beta@example.com',host:'mail.example.com',port:993,username:'beta@example.com',password:secret,allow_agent:true});
 assert.equal((await api(`/api/companies/${a.id}/emails`)).length,2);assert.equal(mailbox.password,undefined);assert.equal(mailbox.encrypted,undefined);
 assert.equal((await request(`/api/companies/${a.id}/emails`,'GET',undefined,null)).status,401);
 assert.equal((await request(`/api/companies/${a.id}/emails/${betaMail.id}`,'PATCH',{label:'stolen'})).status,404);
 await api('/api/companies','POST',{name:'Customer company'},customer);
 assert.equal((await request(`/api/companies/${a.id}/emails/${mailbox.id}`,'PATCH',{label:'stolen'},customer)).status,404);
 assert.deepEqual(await api(`/api/companies/${a.id}/emails`,'GET',undefined,customer),[]);
 const store=createConnections(config.dataDir),worker=store.issue(config.ownerId,'Email QA','worker'),other=store.issue(config.ownerId,'Other worker','worker'),mcp=store.issue(config.ownerId,'MCP','mcp');store.close();
 for(const key of [worker.token,mcp.token])assert.equal((await request(`/api/companies/${a.id}/emails`,'GET',undefined,key)).status,403);
 const thread=await api(`/api/boards/${p.id}/chat/threads`,'POST',{});await api(`/api/chat/threads/${thread.id}/messages`,'POST',{ mode:'work', content:'Verify company sign-in'});const job=(await api('/api/worker/claim','POST',{},worker.token)).job;
 assert.equal(job.hierarchy.company_id,a.id);assert.equal(job.emails.length,1);assert.equal(job.emails[0].id,mailbox.id);assert.ok(!JSON.stringify(job).includes(secret));
 const jr=`/api/worker/jobs/${job.id}/emails`,query={mailbox_id:mailbox.id,sender:'login@example.com',subject:'sign-in verification',since:new Date(sent.getTime()-1000).toISOString()};
 assert.equal((await request(jr+'/code','POST',query,other.token)).status,404);
 assert.equal((await request(jr+'/code','POST',{...query,mailbox_id:betaMail.id},worker.token)).status,404);
 await api(`/api/companies/${a.id}/emails/${mailbox.id}/test`,'POST');assert.ok((await api(`/api/companies/${a.id}/emails`))[1]?.tested_at||(await api(`/api/companies/${a.id}/emails`))[0]?.tested_at);
 const inbox=await api(jr+'/list','POST',{mailbox_id:mailbox.id},worker.token);assert.equal(inbox.messages[0].uid_validity,'71');
 assert.equal((await request(jr+'/read','POST',{mailbox_id:mailbox.id,uid:8,uid_validity:'70'},worker.token)).status,409);
 assert.equal((await request(jr+'/code','POST',{...query,sender:'wrong@example.com'},worker.token)).status,404);
 assert.equal((await request(jr+'/code','POST',{...query,since:new Date(Date.now()-3600000).toISOString()},worker.token)).status,400);
 assert.equal((await api(jr+'/code','POST',query,worker.token)).code,code);
 await api(`/api/worker/jobs/${job.id}`,'POST',{text:`Verification code is ${code}`},worker.token);assert.ok(!JSON.stringify(await api(`/api/chat/threads/${thread.id}`)).includes(code));
 // Pause access, then move the parent during an in-flight request; no data may escape.
 await api(`/api/companies/${a.id}/emails/${mailbox.id}`,'PATCH',{allow_agent:false});assert.equal((await request(jr+'/code','POST',query,worker.token)).status,403);
 await api(`/api/companies/${a.id}/emails/${mailbox.id}`,'PATCH',{allow_agent:true});
 beforeReturn=()=>api(`/api/company-boards/${board.id}`,'PATCH',{company_id:b.id});assert.equal((await request(jr+'/code','POST',query,worker.token)).status,403);beforeReturn=()=>{};
 assert.equal((await request(jr+'/code','POST',{...query,mailbox_id:betaMail.id},worker.token)).status,404);
 await api(`/api/company-boards/${board.id}`,'PATCH',{company_id:a.id});
 broker=await createEmailBroker({socketPath:root+'/email.sock',request:(action,data)=>api(jr+'/'+action,'POST',data,worker.token)});process.env.BOARDLY_EMAIL_SOCKET=broker.socketPath;
 let field='';const page={url:()=> 'https://login.example.com/verify',locator:()=>({fill:async v=>{field=v;}})};
 const result=await fillVerificationCode(page,query,{selector:'#code',origin:'https://login.example.com'});assert.equal(field,code);assert.equal(result.code,undefined);
 await assert.rejects(fillVerificationCode(page,query,{selector:'#code',origin:'https://evil.example.com'}),/changed origin/);await broker.close();broker=null;delete process.env.BOARDLY_EMAIL_SOCKET;
 await api(`/api/worker/jobs/${job.id}`,'POST',{status:'completed',text:'Verified company sign-in'},worker.token);assert.equal((await request(jr+'/code','POST',query,worker.token)).status,404);
 const file=path.join(workspacePath(config.dataDir,config.ownerId),'app.db');for(const f of [file,file+'-wal'])if(fs.existsSync(f)){assert.ok(!fs.readFileSync(f).includes(Buffer.from(secret)));assert.ok(!fs.readFileSync(f).includes(Buffer.from(code)));}
 assert.ok(!JSON.stringify(await api(`/api/boards/${p.id}/export`)).includes(secret));
 await new Promise(r=>server.close(r));app.closeWorkspaces();base=await start();assert.equal((await api('/api/hierarchy')).companies.length,2);assert.equal((await api(`/api/companies/${a.id}/emails`)).length,2);await api(`/api/companies/${a.id}/emails/${mailbox.id}/test`,'POST');
 await api(`/api/companies/${a.id}`,'DELETE');const after=await api('/api/hierarchy');assert.equal(after.boards[0].company_id,null);assert.equal(after.projects[0].id,p.id);assert.equal((await api(`/api/boards/${p.id}`)).lists.length,4);
 assert.deepEqual(codes('Invoice 567899. code is 123456. Verification code: 123456'),['123456']);assert.deepEqual(codes('Verification code 123456. Security code 654321'),['123456','654321']);
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(ip),false);assert.equal(publicAddress('8.8.8.8'),true);
 console.log('PASS: multiple company inboxes, encrypted credentials, account/project/worker isolation, read-only email APIs, fresh-code filtering, in-flight revocation, private browser filling and restart persistence');
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(broker)await broker.close();delete process.env.BOARDLY_EMAIL_SOCKET;if(server?.listening)await new Promise(r=>server.close(r));if(app)app.closeWorkspaces();fs.rmSync(root,{recursive:true,force:true});});
