const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {workspacePath}=require('../server/cloud');
const {createGithubConnections,repositoryName,branchName,filePath}=require('../server/github-connections');
const {loadKey}=require('../server/project-environment');
const sha=value=>crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
function githubFixture(){
 const blobs=new Map(),trees=new Map(),commits=new Map(),calls=[];
 const blob=sha('original');blobs.set(blob,Buffer.from('original source\n'));
 const tree=sha('original tree');trees.set(tree,{'src/app.js':{mode:'100644',sha:blob},'keep.txt':{mode:'100644',sha:blob}});
 let head=sha('original commit');commits.set(head,{sha:head,tree:{sha:tree},parents:[]});
 return{calls,blobs,trees,commits,get head(){return head;},set head(value){head=value;},async request(token,route,{method='GET',body}={}){
  assert.ok(token.startsWith('github_pat_fixture_'));calls.push({route,method,body});
  const suffix=route.replace(/^\/repos\/[\w-]+\/[\w.-]+/,'');
  if(!suffix)return{private:true,permissions:{push:true}};
  if(suffix.startsWith('/git/ref/heads/'))return{object:{sha:head}};
  if(suffix.startsWith('/git/commits/')&&method==='GET')return commits.get(suffix.split('/').pop());
  if(suffix.startsWith('/git/trees/')&&method==='GET'){const id=suffix.split('/').pop().split('?')[0];return{truncated:false,tree:Object.entries(trees.get(id)).map(([path,f])=>({path,type:'blob',...f,size:blobs.get(f.sha).length}))};}
  if(suffix.startsWith('/contents/')){const [p,q]=suffix.slice(10).split('?'),ref=new URLSearchParams(q).get('ref'),f=trees.get(commits.get(ref).tree.sha)[decodeURIComponent(p)];if(!f)throw Object.assign(Error('Missing fixture file'),{status:404});const bytes=blobs.get(f.sha);return{type:'file',encoding:'base64',sha:f.sha,size:bytes.length,content:bytes.toString('base64')};}
  if(suffix==='/git/blobs'&&method==='POST'){const id=sha(body);blobs.set(id,Buffer.from(body.content,'base64'));return{sha:id};}
  if(suffix==='/git/trees'&&method==='POST'){const value={...trees.get(body.base_tree)};for(const f of body.tree){if(f.sha===null)delete value[f.path];else value[f.path]={mode:f.mode,sha:f.sha};}const id=sha(value);trees.set(id,value);return{sha:id};}
  if(suffix==='/git/commits'&&method==='POST'){const id=sha(body);commits.set(id,{sha:id,tree:{sha:body.tree},parents:body.parents});return{sha:id};}
  if(suffix.startsWith('/git/refs/heads/')&&method==='PATCH'){assert.equal(body.force,false);if(commits.get(body.sha).parents[0]!==head)throw Object.assign(Error('Branch moved'),{status:409});head=body.sha;return{object:{sha:head}};}
  throw Error('Unexpected fixture operation '+method+' '+suffix);
 }};
}
if(require.main===module)(async()=>{
 const remote=githubFixture(),token='github_pat_fixture_'+crypto.randomBytes(24).toString('hex');
 const f=await fixture({publicAccess:true,githubRequest:remote.request});let db;
 try{
  assert.equal(repositoryName('https://github.com/northstar/website.git'),'northstar/website');
  for(const value of ['https://evil.test/a/b','https://user:token@github.com/a/b','a/b/../../secrets'])assert.throws(()=>repositoryName(value));
  for(const value of ['-main','main..other','a.lock','a/.hidden','a\\b'])assert.throws(()=>branchName(value));
  for(const value of ['/etc/passwd','../secret','.git/config','a/../secret'])assert.throws(()=>filePath(value));
  const p=await f.project('GitHub company','Website');const base='/api/companies/'+p.company.id+'/github';
  const saved=await f.api(base,{method:'PUT',body:{repository:'northstar/website',branch:'main',token,allow_agent:true}});
  assert.ok(saved.id);assert.ok(!JSON.stringify(saved).includes(token));assert.equal(saved.encrypted,undefined);
  const inherited=await f.api('/api/projects/'+p.project.id+'/github');assert.equal(inherited.effective.id,saved.id);assert.equal(inherited.effective.inherited,true);
  const tested=await f.api(base+'/test',{method:'POST',body:{}});assert.equal(tested.sha,remote.head);assert.equal(tested.can_push,true);
  db=new(require('better-sqlite3'))(path.join(workspacePath(f.root,'user_owner'),'app.db'));
  const raw=db.prepare('SELECT * FROM github_connections').get();assert.ok(!raw.encrypted.includes(token));assert.ok(!fs.readFileSync(path.join(workspacePath(f.root,'user_owner'),'app.db')).includes(Buffer.from(token)));
  const github=createGithubConnections({db,key:loadKey(f.root),namespace:'user_owner',request:remote.request});
  const run=(action,data,valid)=>github.run({projectId:p.project.id,companyId:p.company.id,connectionId:saved.id,action,data,valid});
  const list=await run('list',{});assert.equal(list.files.length,2);const read=await run('read',{sha:list.sha,path:'src/app.js'});assert.equal(Buffer.from(read.content,'base64').toString(),'original source\n');
  const result=await run('commit',{base_sha:list.sha,message:'Update verified website',files:[{path:'src/app.js',content:'verified update\n',mode:'100755'}]});
  assert.equal(result.pushed,true);assert.equal(remote.head,result.sha);assert.ok(treesEntry('keep.txt'));assert.equal(treesEntry('src/app.js').mode,'100755');
  function treesEntry(name){return remote.trees.get(remote.commits.get(remote.head).tree.sha)[name];}
  await assert.rejects(run('commit',{base_sha:list.sha,message:'Stale overwrite',files:[{path:'src/app.js',content:'wrong'}]}),/newer changes/);
  await assert.rejects(run('commit',{base_sha:remote.head,message:'Bad secret',files:[{path:'token.txt',content:token}]}),/private access token/);
  await assert.rejects(run('commit',{base_sha:remote.head,message:'Private env',files:[{path:'.env',content:'SECRET=value'}]}),/private environment/);
  await assert.rejects(run('status',{},()=>false),/removed/);
  let executed=0;const ssh={forJob:()=>({id:'ssh-fixture',updated_at:1}),execute:async(config,options)=>{assert.ok(options.valid());assert.ok(options.command.includes(result.sha));executed++;return{code:0,stdout:'deployed',stderr:'',signal:null};}};
  await assert.rejects(github.run({projectId:p.project.id,companyId:p.company.id,connectionId:saved.id,action:'deploy',data:{sha:list.sha,verification:'Tests passed',ssh_connection_id:'ssh-fixture',command:'deploy exact commit'},ssh}),/Deployment paused/);assert.equal(executed,0);
  const release=await github.run({projectId:p.project.id,companyId:p.company.id,connectionId:saved.id,action:'deploy',data:{sha:result.sha,verification:'Application tests and release build passed',ssh_connection_id:'ssh-fixture',command:'deploy exact commit'},ssh});assert.equal(release.deployed,true);assert.equal(executed,1);
  const projectBase='/api/projects/'+p.project.id+'/github';await f.api(projectBase,{method:'PUT',body:{repository:'northstar/override',branch:'main',token,allow_agent:false}});assert.deepEqual(github.agentList(p.project.id),[]);await assert.rejects(run('status',{}),/not enabled/);
  await f.api(projectBase,{method:'DELETE'});assert.equal(github.agentList(p.project.id)[0].id,saved.id);
  const denied=await f.request(base,{user:'user_other'});assert.equal(denied.status,404);assert.ok(!(await denied.text()).includes(token));
  const member=await f.api('/api/projects/'+p.project.id+'/members',{method:'POST',body:{email:'viewer@example.com',role:'viewer'}});const deniedMember=await f.request(base,{user:member.member.user_id,workspace:'user_owner'});assert.equal(deniedMember.status,403);
  const other=await f.project('Other company','Elsewhere');await f.api('/api/projects/'+p.project.id,{method:'PATCH',body:{parent_board_id:other.board.id}});await assert.rejects(run('status',{}),/company changed/);
  console.log('PASS: encrypted GitHub credentials, scoped inheritance and override, tenant/member isolation, real-shaped read/commit/ref operations, concurrent-change rejection, secret rejection, revocation and push-before-deploy gate');
 }finally{if(db)db.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={githubFixture};
