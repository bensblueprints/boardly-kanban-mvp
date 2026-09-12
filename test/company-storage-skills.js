const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const {publicAddress,endpoint,relativePath}=require('../server/storage-provider');
const {formatInstructions}=require('../server/company-skills');
const xml=s=>({status:200,headers:{'content-type':'application/xml'},body:Buffer.from(s)});
(async()=>{
 for(const ip of ['127.0.0.1','10.0.0.2','192.168.1.2','169.254.169.254','100.100.100.100','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.throws(()=>endpoint('http://storage.example'));assert.throws(()=>endpoint('https://127.0.0.1'));assert.throws(()=>endpoint('https://user:pass@storage.example'));assert.throws(()=>endpoint('https://storage.example:8188'));
 for(const p of ['../file','foo/../bar','/etc/passwd','a\\b','a/%2e%2e/b'])assert.throws(()=>relativePath(p));
 const store=new Map([['root/a.txt',Buffer.from('s3 fixture content')],['dav/a.txt',Buffer.from('webdav fixture content')]]);let writes=0,hold,entered=false,block=false;
 const transport=async(url,opts={})=>{
  url=new URL(url);if(block){entered=true;await new Promise(r=>hold=r);}
  if(url.hostname==='s3.example.test'){
   assert.match(opts.headers.authorization,/AWS4-HMAC-SHA256/);assert.ok(opts.headers.authorization.includes('ACCESS-FIXTURE'));
   if(url.searchParams.get('list-type')==='2'){assert.equal(url.searchParams.get('prefix'),'root/');return xml('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>root/a.txt</Key><Size>18</Size></Contents></ListBucketResult>');}
   const key=decodeURIComponent(url.pathname.slice('/bucket-one/'.length));assert.ok(key.startsWith('root/'));
   if(opts.method==='PUT'){assert.equal(opts.headers['if-none-match'],'*');if(store.has(key))return{status:412,headers:{},body:Buffer.from('<Error><Code>PreconditionFailed</Code></Error>')};writes++;store.set(key,Buffer.from(opts.body));return{status:200,headers:{etag:'"test"'},body:Buffer.alloc(0)};}
   return{status:200,headers:{'content-type':'text/plain'},body:store.get(key)};
  }
  assert.equal(url.hostname,'dav.example.test');assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('dav-user:DAV-PRIVATE-PASSWORD').toString('base64'));
  if(opts.method==='PROPFIND')return{...xml('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/a.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>22</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>https://evil.example/private</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'),status:207};
  const key=decodeURIComponent(url.pathname.slice(1));if(opts.method==='PUT'){assert.equal(opts.headers['If-None-Match'],'*');writes++;store.set(key,opts.body);return{status:201,headers:{},body:Buffer.alloc(0)};}return{status:200,headers:{'content-type':'text/plain'},body:store.get(key)};
 };
 const f=await fixture({storageTransport:transport,publicAccess:true});
 try{
  const a=await f.project('Skills A','Project A'),b=await f.project('Skills B','Project B'),base=`/api/companies/${a.company.id}/skills`,sb=`/api/companies/${a.company.id}/storage`;
  let rules=(await f.api(base)).rules;rules=await f.api(base+'/rules',{method:'PUT',body:{instructions:'A-only workflow rule.',revision:rules.revision}});
  assert.equal((await f.request(base+'/rules',{method:'PUT',body:{instructions:'stale',revision:null}})).status,409);
  let skill=await f.api(base,{method:'POST',body:{name:'marketing-review',description:'For marketing tasks',instructions:'Ask before publishing A.',enabled:true}});
  const markdown=await(await f.request(base+'/'+skill.id+'/export')).text();const draft=await f.api(base+'/import',{method:'POST',body:{markdown}});assert.equal(draft.instructions,skill.instructions);assert.equal(draft.enabled,false);
  assert.equal((await f.request(base+'/import',{method:'POST',body:{markdown:'---\nname: !!js/function x\ndescription: x\n---\nx'}})).status,400);
  assert.equal((await f.request(`/api/companies/${b.company.id}/skills/${skill.id}`,{method:'PATCH',body:{enabled:false,revision:skill.revision}})).status,404);
  const c=await f.api(sb,{method:'POST',body:{provider:'s3',label:'Company bucket',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'bucket-one',prefix:'root',access_key:'ACCESS-FIXTURE',secret_key:'S3-PRIVATE-SECRET',read_only:false}});
  assert.equal(writes,0,'Connection test only reads');assert.ok(!JSON.stringify(c).includes('PRIVATE'));assert.ok(!JSON.stringify(c).includes('ACCESS-FIXTURE'));
  const files=await f.api(sb+'/'+c.id+'/files');assert.equal(files.items[0].path,'a.txt');assert.equal(await(await f.request(sb+'/'+c.id+'/download?path=a.txt')).text(),'s3 fixture content');
  const form=new FormData();form.append('file',new Blob(['new external file'],{type:'text/plain'}),'new.txt');form.append('path','');await f.api(sb+'/'+c.id+'/files',{method:'POST',body:form});assert.equal(writes,1);assert.equal(store.get('root/new.txt').toString(),'new external file');
  assert.equal((await f.request(sb+'/'+c.id+'/files',{method:'POST',body:form})).status,409,'No overwrite or blind retry');assert.equal(writes,1);
  assert.equal((await f.request(`/api/companies/${b.company.id}/storage/${c.id}/files`)).status,404);
  assert.equal((await f.request(sb+'/'+c.id+'/download?path=../private')).status,400);
  const dav=await f.api(sb,{method:'POST',body:{provider:'webdav',label:'Nextcloud',endpoint:'https://dav.example.test/dav/',username:'dav-user',password:'DAV-PRIVATE-PASSWORD',read_only:true}});
  const davFiles=await f.api(sb+'/'+dav.id+'/files');assert.equal(davFiles.items.length,1);assert.equal(davFiles.items[0].name,'a.txt');assert.equal(await(await f.request(sb+'/'+dav.id+'/download?path=a.txt')).text(),'webdav fixture content');
  assert.equal((await f.request(sb+'/'+dav.id+'/files',{method:'POST',body:form})).status,403);
  const editor=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'editor@fixture.example',role:'editor'}})).member.user_id,ed={user:editor,workspace:'user_owner'};
  const viewer=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'viewer@fixture.example',role:'viewer'}})).member.user_id,v={user:viewer,workspace:'user_owner'};
  assert.equal((await f.api(base,ed)).skills.length,1);assert.equal((await f.request(base+'/rules',{...ed,method:'PUT',body:{instructions:'member override',revision:rules.revision}})).status,403);
  assert.equal((await f.request(sb,{...ed,method:'POST',body:{}})).status,403);assert.equal((await f.request(sb+'/'+c.id+'/files',{...v,method:'POST',body:form})).status,403);assert.equal((await f.api(sb,v)).connections.length,2);
  const guest=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'guest@fixture.example',role:'editor'}})).member.user_id;assert.equal((await f.request(sb,{user:guest,workspace:'user_owner'})).status,404);
  const disk=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));assert.ok(!JSON.stringify(disk.prepare('SELECT * FROM company_storage').all()).includes('PRIVATE'));
  const context=require('../server/company-skills').projectInstructions(disk,a.project.id);assert.match(formatInstructions(context),/A-only workflow/);assert.equal(require('../server/company-skills').projectInstructions(disk,b.project.id).skills.length,0);
  skill=await f.api(base+'/'+skill.id,{method:'PATCH',body:{enabled:false,revision:skill.revision}});assert.equal(require('../server/company-skills').projectInstructions(disk,a.project.id).skills.length,0);
  block=true;const pending=f.request(sb+'/'+c.id+'/files',ed);for(let i=0;i<200&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.ok(entered,'in-flight storage request started');const grants=await f.api(`/api/companies/${a.company.id}/members`);await f.api('/api/memberships/'+grants.members.find(g=>g.email==='editor@fixture.example').grant_id,{method:'DELETE'});hold();assert.equal((await pending).status,404,'In-flight result withheld after access revoked');block=false;
  await f.api(sb+'/'+c.id,{method:'DELETE',body:{revision:c.revision}});assert.ok(store.has('root/new.txt'));assert.equal((await f.api('/api/storage')).usedBytes,0,'External files do not consume Boardly upload allowance');disk.close();
  console.log('PASS: S3 signed wire requests, WebDAV XML, file upload/download, prefix boundaries, no overwrite, encrypted credentials, public-address restrictions, company/member/guest isolation, in-flight revocation, rules revisions, skill import/export and scoped inheritance');
 }finally{block=false;hold?.();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
