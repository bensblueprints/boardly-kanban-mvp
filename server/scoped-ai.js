const express=require('express'),crypto=require('node:crypto');
const fail=(status,message)=>Object.assign(Error(message),{status});

// Keep existing company settings compatible. Descendants select reusable keys;
// they never copy credentials or modify a parent's default.
function createCompanyAI({db,ownerId,personal,organizationRespond}){
 const providers=personal.providers;
 db.exec(`CREATE TABLE IF NOT EXISTS company_ai_settings(company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,source TEXT NOT NULL,provider TEXT,model TEXT,revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS department_ai_settings(department_id INTEGER PRIMARY KEY REFERENCES company_boards(id) ON DELETE CASCADE,source TEXT NOT NULL,provider TEXT,model TEXT,credential_company_id INTEGER,revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS project_ai_settings(project_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,source TEXT NOT NULL,provider TEXT,model TEXT,credential_company_id INTEGER,revision TEXT NOT NULL);`);
 const schemas={company:['company_ai_settings','company_id'],department:['department_ai_settings','department_id'],project:['project_ai_settings','project_id']};
 const target=value=>value==null?{kind:'organization',id:0}:typeof value==='object'?{kind:value.kind,id:Number(value.id)}:{kind:'company',id:Number(value)};
 function describe(value){
  const t=target(value);let row;
  if(t.kind==='organization'&&t.id===0)return {...t,name:'Organization',label:'Organization',company_id:null,parent:null};
  if(!schemas[t.kind]||!Number.isSafeInteger(t.id)||t.id<1)throw fail(400,'Choose a Company, Department or Board.');
  if(t.kind==='company')row=db.prepare('SELECT id,name,id AS company_id FROM companies WHERE id=?').get(t.id);
  if(t.kind==='department')row=db.prepare('SELECT id,name,company_id FROM company_boards WHERE id=?').get(t.id);
  if(t.kind==='project')row=db.prepare('SELECT p.workspace_id AS id,p.name,p.parent_board_id,b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(t.id);
  if(!row)throw fail(404,`${t.kind==='project'?'Board':t.kind==='department'?'Department':'Company'} not found.`);
  const parent=t.kind==='project'?{kind:'department',id:row.parent_board_id}:t.kind==='department'&&row.company_id!=null?{kind:'company',id:row.company_id}:null;
  return {...row,...t,label:t.kind==='project'?'Board':t.kind==='department'?'Department':'Company',parent};
 }
 function policy(value){
  const t=target(value);if(t.kind==='organization')return {source:'inherit'};
  const schema=schemas[t.kind];if(!schema)throw fail(400,'Unknown AI scope.');
  return db.prepare(`SELECT * FROM ${schema[0]} WHERE ${schema[1]}=?`).get(t.id)||{source:'inherit'};
 }
 function chain(value){const list=[];let next=value;do{const s=describe(next);list.push(s);next=s.parent;}while(list.at(-1).kind!=='organization');return list;}
 function organization(){const a=personal.account(ownerId),active=providers.activeState(ownerId);return {source:'inherit',provider:a.mode==='provider'?active.provider:a.mode==='key'?'openai':a.mode==='none'?'subscription':a.mode,model:a.mode==='provider'?active.model:a.model};}
 function resolve(value,draft){
  const levels=chain(value);
  for(let i=0;i<levels.length;i++){
   const s=levels[i];if(s.kind==='organization')return {scope:s,policy:organization(),levels,override:false};
   const p=i===0&&draft?draft:policy(s);
   if(p.source!=='inherit'){
    const credentialCompanyId=p.source==='company'?(s.kind==='company'||i===0&&draft?s.company_id:p.credential_company_id):undefined;
    return {scope:s,policy:p,levels,override:true,credentialCompanyId,invalid:p.source==='company'&&(credentialCompanyId==null||credentialCompanyId!==levels[0].company_id)};
   }
  }
 }
 function fingerprint(value){const r=resolve(value);return JSON.stringify({levels:r.levels.map(s=>[s.kind,s.id,s.company_id]),scope:[r.scope.kind,r.scope.id],policy:r.policy,credentialCompanyId:r.credentialCompanyId});}
 function effective(value){const r=resolve(value);return {source:policy(value).source,provider:r.policy.provider,model:r.policy.model,inherited_from:{kind:r.scope.kind,id:r.scope.id,name:r.scope.name,label:r.scope.label},...(r.invalid?{error:'This Board or Department moved to another Company. Choose and save its AI connection again.'}:{})};}
 const hasOverride=value=>resolve(value).override;
 const project=id=>describe({kind:'project',id}).company_id;
 const scope=(kind,id)=>kind==='company'?{kind,id:Number(id)}:kind==='board'?{kind:'department',id:Number(id)}:kind==='project'?{kind,id:Number(id)}:null;
 function job(id){
  if(!id)return null;
  const t=db.prepare('SELECT t.board_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id WHERE j.id=?').get(id);
  if(t)return {kind:'project',id:t.board_id};
  const d=db.prepare('SELECT t.scope_type,t.scope_id FROM discussion_jobs j JOIN discussion_threads t ON t.id=j.thread_id WHERE j.id=?').get(id);
  if(d)return scope(d.scope_type,d.scope_id);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='company_build_turns'").get()){const build=db.prepare('SELECT d.company_id FROM company_build_turns t JOIN company_build_drafts d ON d.id=t.draft_id WHERE t.id=?').get(id);if(build?.company_id!=null)return {kind:'company',id:build.company_id};}
  return null;
 }
 function request(req){
  let m=req.path.match(/^\/api\/(?:agents|audio)\/(company|board|project)\/(\d+)/);if(m)return scope(m[1],m[2]);
  m=req.path.match(/^\/api\/boards\/(\d+)/);if(m)return {kind:'project',id:Number(m[1])};
  m=req.path.match(/^\/api\/chat\/jobs\/([^/]+)/);if(m)return job(m[1]);
  m=req.path.match(/^\/api\/chat\/threads\/([^/]+)/);if(m){const t=db.prepare('SELECT board_id FROM chat_threads WHERE id=?').get(m[1]);return t?{kind:'project',id:t.board_id}:null;}
  m=req.path.match(/^\/api\/discussions\/threads\/([^/]+)/);if(m){const t=db.prepare('SELECT scope_type,scope_id FROM discussion_threads WHERE id=?').get(m[1]);return t?scope(t.scope_type,t.scope_id):null;}
  m=req.path.match(/^\/api\/company-onboarding\/drafts\/([^/]+)/);if(m){const d=db.prepare('SELECT company_id FROM company_build_drafts WHERE id=?').get(m[1]);return d?.company_id!=null?{kind:'company',id:d.company_id}:null;}
  return null;
 }
 function state(value){
  const s=describe(value),parent=describe(s.parent);
  return {scope:s,company_id:s.company_id,policy:policy(s),effective:effective(s),parent:{scope:parent,...effective(parent)},organization:organization(),organization_connections:providers.providers.map(p=>providers.publicState(ownerId,p)),company_connections:s.company_id==null?[]:providers.providers.map(p=>providers.publicState(ownerId,p,s.company_id))};
 }
 async function authorize(value){
  const r=resolve(value);if(!r.override)return null;
  const before=fingerprint(value),valid=()=>{if(fingerprint(value)!==before)throw fail(409,'AI settings or location changed. Resume using the current selection.');if(r.invalid)throw fail(409,'The Company connection changed after a move. Choose and save this scope’s AI connection again.');};
  valid();return providers.authorizeSelection(ownerId,r.policy.provider,r.policy.model,r.credentialCompanyId,valid);
 }
 function validateSource(data){if(!['inherit','organization','company'].includes(data.source))throw fail(400,'Choose inheritance, an Organization connection or a Company connection.');}
 async function save(value,data,valid){
  valid();const s=describe(value),before=fingerprint(s);validateSource(data);
  if(data.source!=='inherit'){
   if(!providers.providers.includes(data.provider)||typeof data.model!=='string')throw fail(400,'Choose a verified provider and model.');
   if(data.source==='company'&&s.company_id==null)throw fail(400,'Assign this scope to a Company before using a Company connection.');
   await providers.authorizeSelection(ownerId,data.provider,data.model,data.source==='company'?s.company_id:undefined,valid);
  }
  valid();if(fingerprint(s)!==before)throw fail(409,'AI settings or location changed. Refresh and retry.');
  const [table,key]=schemas[s.kind],values=[s.id,data.source,data.source==='inherit'?null:data.provider,data.source==='inherit'?null:data.model];
  if(s.kind!=='company')values.push(data.source==='company'?s.company_id:null);values.push(crypto.randomUUID());
  db.prepare(`INSERT INTO ${table} VALUES(${values.map(()=>'?').join(',')}) ON CONFLICT(${key}) DO UPDATE SET source=excluded.source,provider=excluded.provider,model=excluded.model,${s.kind!=='company'?'credential_company_id=excluded.credential_company_id,':''}revision=excluded.revision`).run(...values);
  return state(s);
 }
 const pendingProbes=new Map();
 async function test(value,data,valid){
  valid();const s=describe(value);validateSource(data);
  const r=resolve(s,data),before=fingerprint(s.parent),location=JSON.stringify(chain(s).map(v=>[v.kind,v.id,v.company_id]));
  const check=()=>{valid();if(JSON.stringify(chain(s).map(v=>[v.kind,v.id,v.company_id]))!==location)throw fail(409,'AI scope moved during the test. Test its current selection.');if(data.source==='inherit'&&fingerprint(s.parent)!==before)throw fail(409,'Inherited AI changed during the test. Test the current selection.');if(r.invalid)throw fail(409,'Choose the current Company connection and save the selection again.');};
  check();
  if(providers.providers.includes(r.policy.provider))return providers.test(ownerId,r.policy.provider,r.policy.model,check,r.credentialCompanyId);
  if(data.source!=='inherit')throw fail(400,'Choose a verified provider and model.');
  if(pendingProbes.size)throw fail(409,'A model test is already running. Wait for its reply before testing again.');
  const id='ai-ping-'+crypto.randomUUID();pendingProbes.set(id,s);
  try{return await require('./ai-probe').probe({id,provider:r.policy.provider,model:r.policy.model,valid:check,respond:(job,payload)=>organizationRespond(job,payload)});}
  finally{pendingProbes.delete(id);}
 }
 const liveProbe=(actor,id)=>{if(actor!==ownerId||!pendingProbes.has(id))return false;try{describe(pendingProbes.get(id));return true;}catch{return false;}};
 const router=express.Router();
 const handle=(kind,fn)=>async(req,res,next)=>{try{
  const t={kind,id:Number(req.params.id)};
  const valid=()=>{if(!req.workspaceIsOwner||(req.boardlyConnection&&!req.boardlyManagement))throw fail(403,'Only the Organization owner can manage AI defaults.');describe(t);};
  valid();res.set('Cache-Control','no-store');res.json(await fn(t,req,valid));
 }catch(e){next(e);}};
 for(const [kind,path] of [['company','companies'],['department','departments'],['project','projects']]){
  router.get(`/api/${path}/:id/ai`,handle(kind,t=>state(t)));
  router.post(`/api/${path}/:id/ai/test`,express.json({limit:'4kb'}),handle(kind,(t,req,valid)=>test(t,req.body||{},valid)));
  router.put(`/api/${path}/:id/ai`,express.json({limit:'4kb'}),handle(kind,(t,req,valid)=>save(t,req.body||{},valid)));
 }
 router.put('/api/companies/:id/ai/providers/:provider',express.json({limit:'8kb'}),handle('company',(t,req,valid)=>providers.save(ownerId,req.params.provider,req.body||{},valid,t.id)));
 return {router,policy,effective,authorize,hasOverride,fingerprint,project,scope,job,request,state,liveProbe};
}
module.exports={createCompanyAI};
