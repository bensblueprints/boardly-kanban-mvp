const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDb}=require('../server/db'),{createHierarchy}=require('../server/hierarchy'),{createCompanyEmail}=require('../server/company-email'),{createImapFixture}=require('./imap-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'boardly-imap-test-'));let fixture,db;
(async()=>{
 fixture=await createImapFixture(root);db=openDb(root+'/data');const company=createHierarchy(db).createCompany({name:'Fixture company'});
 const email=createCompanyEmail({db,key:crypto.randomBytes(32),namespace:'fixture',connector:fixture.connector});
 const mailbox=email.save(company.id,{label:'Fixture',email:'ops@example.com',username:'ops@example.com',password:fixture.password,host:'mail.fixture.test',port:993,allow_agent:true});
 assert.equal((await email.operate(company.id,mailbox.id,'test')).ok,true);
 const inbox=await email.operate(company.id,mailbox.id,'list');assert.equal(inbox.messages[0].uid,9);assert.equal(inbox.messages[0].uid_validity,'81');
 const message=await email.operate(company.id,mailbox.id,'read',{uid:9,uid_validity:'81'});assert.ok(message.text.includes(fixture.code));
 const result=await email.operate(company.id,mailbox.id,'code',{sender:'login@example.com',subject:'verification',since:new Date(fixture.date.getTime()-2000).toISOString()});assert.equal(result.code,fixture.code);
 assert.ok(fixture.commands.includes('EXAMINE'));assert.ok(!fixture.commands.some(c=>/SELECT|STORE|APPEND|EXPUNGE|DELETE/.test(c)));
 console.log('PASS: actual ImapFlow TLS authentication, read-only EXAMINE, UID-based inbox/read, MIME decoding and fresh verification-code retrieval');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(db)db.close();if(fixture)await fixture.close();fs.rmSync(root,{recursive:true,force:true});});
