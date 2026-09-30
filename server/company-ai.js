const express=require('express'),crypto=require('node:crypto');
const fail=(status,message)=>Object.assign(Error(message),{status});

// Policy lives with the company. Keys stay in the encrypted provider store, in
// a separate namespace for each organization/company pair.
function createCompanyAI({db,ownerId,personal,organizationRespond}){
 const providers=personal.providers;
 db.exec(`CREATE TABLE IF NOT EXISTS company_ai_settings(company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,source TEXT NOT NULL,provider TEXT,model TEXT,revision TEXT NOT NULL);`);
 const company=id=>{const c=db.prepare('SELECT id,name FROM companies WHERE id=?').get(id);if(!c)throw fail(404,'Company not found.');return c;};
 const policy=id=>id==null?{source:'inherit'}:db.prepare('SELECT * FROM company_ai_settings WHERE company_id=?').get(id)||{source:'inherit'};
 const project=id=>db.prepare('SELECT b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(id)?.company_id??null;
 const scope=(kind,id)=>kind==='company'?Number(id):kind==='board'?db.prepare('SELECT company_id FROM company_boards WHERE id=?').get(id)?.company_id??null:kind==='project'?project(id):null;
 function job(id){
  if(!id)return null;
  const t=db.prepare('SELECT t.board_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id WHERE j.id=?').get(id);
  if(t)return project(t.board_id);
  const d=db.prepare('SELECT t.scope_type,t.scope_id FROM discussion_jobs j JOIN discussion_threads t ON t.id=j.thread_id WHERE j.id=?').get(id);
  return d?scope(d.scope_type,d.scope_id):null;
 }
 function request(req){
  let m=req.path.match(/^\/api\/(?:agents|audio)\/(company|board|project)\/(\d+)/);if(m)return scope(m[1],m[2]);
  m=req.path.match(/^\/api\/boards\/(\d+)/);if(m)return project(m[1]);
  m=req.path.match(/^\/api\/chat\/threads\/([^/]+)/);if(m){const t=db.prepare('SELECT board_id FROM chat_threads WHERE id=?').get(m[1]);return t?project(t.board_id):null;}
  m=req.path.match(/^\/api\/discussions\/threads\/([^/]+)/);if(m){const t=db.prepare('SELECT scope_type,scope_id FROM discussion_threads WHERE id=?').get(m[1]);return t?scope(t.scope_type,t.scope_id):null;}
  return null;
 }
 function effective(id){
  const p=policy(id),a=personal.account(ownerId),active=providers.activeState(ownerId);
  return p.source==='inherit'?{source:'inherit',provider:a.mode==='provider'?active.provider:a.mode==='key'?'openai':a.mode==='none'?'subscription':a.mode,model:a.mode==='provider'?active.model:a.model}: {source:p.source,provider:p.provider,model:p.model};
 }
 function state(id){company(id);return {company_id:id,policy:policy(id),effective:effective(id),organization:effective(null),organization_connections:providers.providers.map(p=>providers.publicState(ownerId,p)),company_connections:providers.providers.map(p=>providers.publicState(ownerId,p,id))};}
 async function authorize(id){
  const p=policy(id);if(p.source==='inherit')return null;
  const valid=()=>{company(id);if(policy(id).revision!==p.revision)throw fail(409,'Company AI settings changed. Resume using its current selection.');};
  return providers.authorizeSelection(ownerId,p.provider,p.model,p.source==='company'?id:undefined,valid);
 }
 async function save(id,data,valid){
  valid();company(id);const before=policy(id).revision;
  if(!['inherit','organization','company'].includes(data.source))throw fail(400,'Choose inheritance, an Organization connection or a company connection.');
  if(data.source!=='inherit'){
   if(!providers.providers.includes(data.provider)||typeof data.model!=='string')throw fail(400,'Choose a verified provider and model.');
   await providers.authorizeSelection(ownerId,data.provider,data.model,data.source==='company'?id:undefined,valid);
  }
  valid();company(id);if(policy(id).revision!==before)throw fail(409,'Company AI settings changed. Refresh and retry.');
  db.prepare('INSERT INTO company_ai_settings VALUES(?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET source=excluded.source,provider=excluded.provider,model=excluded.model,revision=excluded.revision').run(id,data.source,data.source==='inherit'?null:data.provider,data.source==='inherit'?null:data.model,crypto.randomUUID());
  return state(id);
 }
 const pendingProbes=new Map();
 async function test(id,data,valid){
  valid();if(!['inherit','organization','company'].includes(data.source))throw fail(400,'Choose the AI connection source to test.');
  if(data.source!=='inherit')return providers.test(ownerId,data.provider,data.model,valid,data.source==='company'?id:undefined);
  const selected=effective(null),snapshot=JSON.stringify(selected);
  const check=()=>{valid();if(JSON.stringify(effective(null))!==snapshot)throw fail(409,'Organization AI changed during the test. Test the current selection.');};
  if(providers.providers.includes(selected.provider))return providers.test(ownerId,selected.provider,selected.model,check);
  if(pendingProbes.size)throw fail(409,'A model test is already running. Wait for its reply before testing again.');
  const jobId='ai-ping-'+crypto.randomUUID();pendingProbes.set(jobId,id);
  try{return await require('./ai-probe').probe({id:jobId,provider:selected.provider,model:selected.model,valid:check,respond:(job,payload)=>organizationRespond(job,payload)});}
  finally{pendingProbes.delete(jobId);}
 }
 const liveProbe=(actor,id)=>actor===ownerId&&pendingProbes.has(id)&&!!db.prepare('SELECT 1 FROM companies WHERE id=?').get(pendingProbes.get(id));
 const router=express.Router();
 const handle=fn=>async(req,res,next)=>{try{
  const valid=()=>{if(!req.workspaceIsOwner||(req.boardlyConnection&&!req.boardlyManagement))throw fail(403,'Only the Organization owner can manage company AI settings.');company(Number(req.params.id));};
  valid();res.set('Cache-Control','no-store');res.json(await fn(Number(req.params.id),req,valid));
 }catch(e){next(e);}};
 router.get('/api/companies/:id/ai',handle(id=>state(id)));
 router.post('/api/companies/:id/ai/test',express.json({limit:'4kb'}),handle((id,req,valid)=>test(id,req.body||{},valid)));
 router.put('/api/companies/:id/ai',express.json({limit:'4kb'}),handle((id,req,valid)=>save(id,req.body||{},valid)));
 router.put('/api/companies/:id/ai/providers/:provider',express.json({limit:'8kb'}),handle((id,req,valid)=>providers.save(ownerId,req.params.provider,req.body||{},valid,id)));
 return {router,policy,effective,authorize,project,scope,job,request,state,liveProbe};
}
module.exports={createCompanyAI};
