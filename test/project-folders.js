const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Database=require('better-sqlite3'),{fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async()=>{
 const old=new Database(':memory:');old.pragma('foreign_keys=ON');old.exec("CREATE TABLE boards(id INTEGER PRIMARY KEY); INSERT INTO boards VALUES(1); CREATE TABLE project_files(id INTEGER PRIMARY KEY,uuid TEXT,board_id INTEGER REFERENCES boards(id),name TEXT,filename TEXT,url TEXT,size INTEGER,mime TEXT,created_at INTEGER); INSERT INTO project_files VALUES(7,'unchanged',1,'old.txt','stored-original',NULL,42,'text/plain',100);");
 const before=old.prepare('SELECT * FROM project_files').get();require('../server/project-assets').installProjectAssets(old);require('../server/project-assets').installProjectAssets(old);
 const after=old.prepare('SELECT * FROM project_files').get();assert.equal(after.folder_id,null);delete after.folder_id;assert.deepEqual(after,before);assert.equal(old.pragma('integrity_check',{simple:true}),'ok');old.close();
 let phase=0,hostedFolder,hostedFile,targetId,foreignFile;const f=await fixture({providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});
  const input=JSON.parse(opts.body),last=input.input.filter(x=>x.type==='function_call_output').at(-1);const result=last?JSON.parse(last.output):null;phase++;
  if(phase===2)hostedFolder=result.id;if(phase===3)hostedFile=result.id;if(phase===4)assert.match(result.error,/File not found/);if(phase===5)assert.equal(result.folder_id,targetId);
  const actions=[['create_folder',{name:'Agent outputs',parent_id:null}],['save_file',{name:'agent.txt',content:'Generated inside a folder',folder_id:hostedFolder}],['move_file',{id:foreignFile,folder_id:targetId}],['move_file',{id:hostedFile,folder_id:targetId}]];
  const action=actions[phase-1],output=action?[{type:'function_call',id:'fc_'+phase,call_id:'call_'+phase,name:action[0],arguments:JSON.stringify(action[1])}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Created and organized the project file.'}]}];
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',service_tier:'default',usage:{input_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens:50},output});
 }});let client,db;
 try{
  const a=await f.project('Folder company','Documents'),b=await f.project('Other company','Private files'),base=`/api/boards/${a.project.id}`;
  const folder=(name,parent_id=null,project=a.project.id)=>f.api(`/api/boards/${project}/folders`,{method:'POST',body:{name,parent_id}});
  const docs=await folder('Documents'),images=await folder('Images'),drafts=await folder('Drafts',docs.id),outside=await folder('Private',null,b.project.id);targetId=drafts.id;
  const linked=await f.api(base+'/file-links',{method:'POST',body:{name:'reference.pdf',url:'https://example.com/reference.pdf',folder_id:drafts.id}});
  const foreign=await f.api(`/api/boards/${b.project.id}/file-links`,{method:'POST',body:{name:'private.txt',url:'https://example.com/private'}});foreignFile=foreign.id;
  const upload=async(folder_id,user)=>{const form=new FormData();if(folder_id!==undefined)form.set('folder_id',String(folder_id));form.set('file',new Blob(['original contents'],{type:'text/plain'}),'notes.txt');return f.request(base+'/files',{method:'POST',body:form,user});};
  let response=await upload();assert.equal(response.status,201);const file=await response.json(),usage=(await f.api(base+'/files')).storage.usedBytes;
  const moved=await f.api(`/api/project-files/${file.id}`,{method:'PATCH',body:{folder_id:drafts.id}});assert.equal(moved.filename,file.filename);assert.equal(moved.uuid,file.uuid);
  assert.equal(await (await f.request(`/api/project-files/${file.id}/download`)).text(),'original contents');
  let listing=await f.api(base+'/files');assert.equal(listing.storage.usedBytes,usage);assert.equal(listing.files.find(x=>x.id===file.id).folder_path,'Documents/Drafts');assert.ok(listing.files.some(x=>x.id===linked.id));
  await f.api(`/api/project-folders/${docs.id}`,{method:'PATCH',body:{name:'Client documents'}});assert.equal((await f.api(base+'/files')).files.find(x=>x.id===file.id).folder_path,'Client documents/Drafts');
  assert.equal((await f.request(`/api/project-folders/${docs.id}`,{method:'DELETE'})).status,409);assert.equal((await f.request(`/api/project-folders/${drafts.id}`,{method:'DELETE'})).status,409);
  assert.equal((await f.request(base+'/folders',{method:'POST',body:{name:'IMAGES'}})).status,409);
  for(const name of ['', '..','../outside','a/b','a\\b','bad\u0000name','x'.repeat(121)])assert.equal((await f.request(base+'/folders',{method:'POST',body:{name}})).status,400);
  for(const endpoint of [base+'/folders',base+'/file-links',`/api/project-files/${file.id}`]){
   const body=endpoint.endsWith('/folders')?{name:'bad',parent_id:outside.id}:endpoint.endsWith('/file-links')?{name:'bad',url:'https://example.com',folder_id:outside.id}:{folder_id:outside.id};
   assert.equal((await f.request(endpoint,{method:endpoint.includes('/project-files/')?'PATCH':'POST',body})).status,404);
  }
  const uploads=path.join(workspacePath(f.root,'user_owner'),'uploads'),count=fs.readdirSync(uploads).length;assert.equal((await upload(outside.id)).status,404);assert.equal(fs.readdirSync(uploads).length,count,'rejected uploads leave no orphan bytes');
  assert.equal((await f.request(`/api/project-files/${file.id}`,{method:'PATCH',body:{folder_id:[]}})).status,400);
  response=await upload(images.id);assert.equal(response.status,201);assert.equal((await response.json()).folder_id,images.id);
  const editor=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'editor@example.com',role:'editor'}})).member.user_id,viewer=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'viewer@example.com',role:'viewer'}})).member.user_id;
  assert.equal((await f.api(base+'/files',{user:viewer})).folders.length,3);assert.equal((await f.api(base+'/files',{user:viewer})).storage,null);
  for(const [route,method,body]of [[base+'/folders','POST',{name:'Forbidden'}],[`/api/project-folders/${images.id}`,'PATCH',{name:'Forbidden'}],[`/api/project-folders/${images.id}`,'DELETE'],[`/api/project-files/${file.id}`,'PATCH',{folder_id:null}]])assert.equal((await f.request(route,{user:viewer,method,body})).status,403);
  const team=await f.api(base+'/folders',{user:editor,method:'POST',body:{name:'Team'}});await f.api(`/api/project-files/${file.id}`,{user:editor,method:'PATCH',body:{folder_id:team.id}});
  assert.equal((await f.request(`/api/project-folders/${outside.id}`,{user:editor,method:'PATCH',body:{name:'Forbidden'}})).status,404);
  assert.equal((await f.request(`/api/project-files/${foreign.id}`,{user:editor,method:'PATCH',body:{folder_id:team.id}})).status,404);
  assert.equal((await f.request(`/api/project-files/${file.id}`,{user:editor,method:'PATCH',body:{folder_id:outside.id}})).status,404);
  const grant=(await f.api(`/api/projects/${a.project.id}/members`)).members.find(m=>m.email==='editor@example.com').grant_id;await f.api(`/api/memberships/${grant}`,{method:'DELETE'});assert.equal((await f.request(base+'/folders',{user:editor,method:'POST',body:{name:'Revoked'}})).status,403);
  await f.api(`/api/project-files/${file.id}`,{method:'PATCH',body:{folder_id:null}});await f.api(`/api/project-folders/${team.id}`,{method:'DELETE'});
  const connection=await f.api('/api/connections',{method:'POST',body:{scope:'mcp',name:'Folder test'}});client=new Client({name:'folders',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+connection.token}}}));
  const mcp=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const generatedFolder=await mcp('create_project_folder',{board_id:a.project.id,name:'Generated',parent_id:docs.id}),generated=await mcp('add_project_file',{board_id:a.project.id,name:'generated.txt',content:'MCP folder output',folder_id:generatedFolder.id});
  assert.equal((await mcp('list_project_files',{board_id:a.project.id})).find(x=>x.id===generated.id).folder_path,'Client documents/Generated');
  assert.equal((await mcp('read_project_file',{file_id:generated.id})).content,'MCP folder output');await mcp('move_project_file',{file_id:generated.id,folder_id:drafts.id});await mcp('delete_project_folder',{folder_id:generatedFolder.id});await client.close();client=null;
  const store=require('../server/connections').createConnections(f.root),worker=store.issue('user_owner','Folder worker test','worker');store.close();
  const w=async(route,body)=>{const r=await fetch(f.base+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+worker.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok);return r;};
  const thread=await f.api(base+'/chat/threads',{method:'POST',body:{}}),job=await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Read the organized project files'}});const claim=(await(await w('/api/worker/claim',{})).json()).job;assert.equal(claim.id,job.id);assert.equal(claim.files.find(x=>x.id===generated.id).folder_path,'Client documents/Drafts');assert.ok(!claim.files.some(x=>x.id===foreign.id));assert.equal(await(await w(`/api/worker/jobs/${job.id}/files/${generated.id}`)).text(),'MCP folder output');await w(`/api/worker/jobs/${job.id}`,{status:'completed',text:'Read files'});
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  await f.api(`/api/chat/threads/${thread.id}/messages`,{method:'POST',body:{mode:'work',content:'Create and organize the agent output'}});let history;for(let i=0;i<100;i++){history=await f.api(`/api/chat/threads/${thread.id}`);if(history.job.status==='completed')break;await new Promise(r=>setTimeout(r,30));}assert.equal(history.job.status,'completed');assert.equal(phase,5);assert.equal((await f.api(base+'/files')).files.find(x=>x.id===hostedFile).folder_id,drafts.id);
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'),{readonly:true});assert.equal(db.prepare('SELECT name FROM project_folders WHERE id=?').get(docs.id).name,'Client documents');assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();db=null;
  await f.api(`/api/boards/${a.project.id}`,{method:'DELETE'});assert.equal((await f.request(base+'/files')).status,404);
  console.log('PASS: legacy migration, nested folders, duplicate/name validation, folder uploads and links, safe moves/downloads, storage preservation, empty deletion, member/revocation/project isolation, MCP output folders, native worker downloads, hosted agent folder actions and project cascade deletion');
 }finally{db?.close();if(client)await client.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
