const express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
const {SCOPE_IDS,readScopes}=require('./member-permissions');
function accessForMember(db,grants){
 const companies=new Map(),direct=new Map();
 for(const g of grants){const map=g.kind==='company'?companies:direct;if(g.role==='editor'||!map.has(g.resource_id))map.set(g.resource_id,g.role);}
 const project=id=>{const row=db.prepare('SELECT p.workspace_id,b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(id);if(!row)return null;const a=direct.get(Number(id)),b=companies.get(row.company_id);return a==='editor'||b==='editor'?'editor':a||b||null;};
 function capabilities(kind,id){
  id=Number(id);let companyId=id;
  if(kind==='project'){if(!project(id))return[];companyId=db.prepare('SELECT b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(id)?.company_id;}
  const permitted=grants.filter(g=>(g.kind==='company'&&g.resource_id===companyId)||(kind==='project'&&g.kind==='project'&&g.resource_id===id&&(g.scope_company_id??null)===(companyId??null))).flatMap(g=>readScopes(g.scopes));
  if(grants.some(g=>g.owner_ssh)&&(kind==='project'?!!project(id):companies.has(id)))permitted.push('ssh');
  return SCOPE_IDS.filter(scope=>permitted.includes(scope));
 }
 function filter(tree){const projects=tree.projects.filter(p=>project(p.id)).map(p=>({...p,role:project(p.id),scopes:capabilities('project',p.id)})),parents=new Set(projects.map(p=>p.parent_board_id));const boards=tree.boards.filter(b=>parents.has(b.id)||companies.has(b.company_id)),companyIds=new Set(boards.map(b=>b.company_id));return{companies:tree.companies.filter(c=>companies.has(c.id)||companyIds.has(c.id)).map(c=>({...c,description:'',role:companies.get(c.id)||'project_guest',scopes:capabilities('company',c.id)})),boards:boards.map(b=>({...b,description:''})),projects,owner:false};}
 return{project,company:id=>companies.get(Number(id))||null,capabilities,filter};
}
function memberGuard({db,memberships,ownerId,userId}){
 const router=express.Router();router.use(express.json({limit:'2mb'}));
 router.use((req,res,next)=>{
  try{
   const permissions=()=>accessForMember(db,memberships.grants(ownerId,userId));
   const scope=permissions(),route=req.path.toLowerCase().replace(/\/$/,''),method=req.method==='HEAD'?'GET':req.method,write=method!=='GET';
   // Optional privileges are independent of the task Editor/Viewer role.
   // Match only the existing connector routes, then recheck live grants for
   // async provider operations as well as the initial HTTP request.
   let privileged;
   const connection=route.match(/^\/api\/(companies|projects)\/(\d+)\/(ssh|github)(?:\/([\w-]+))?(?:\/(test))?$/);
   if(connection){
    const [,kind,id,cap,part,test]=connection;
    const permitted=cap==='github'?(!part&&['GET','PUT','DELETE'].includes(method))||(['test','repositories'].includes(part)&&!test&&method==='POST'):(!part&&['GET','POST'].includes(method))||(part&&!test&&['PATCH','DELETE'].includes(method))||(part&&test&&method==='POST');
    if(permitted)privileged={kind:kind==='companies'?'company':'project',id:Number(id),cap};
   }
   const secret=route.match(/^\/api\/boards\/(\d+)\/(environment|payments)(.*)$/);
   if(secret){
    const [,id,cap,suffix]=secret;
    const permitted=cap==='environment'?(!suffix&&method==='GET')||(/^\/[a-z_][a-z0-9_]*$/.test(suffix)&&['PUT','DELETE'].includes(method)):
      (!suffix&&method==='GET')||(suffix==='/cards'&&method==='POST')||(/^\/cards\/[\w-]+$/.test(suffix)&&['PATCH','DELETE'].includes(method))||(/^\/cards\/[\w-]+\/billing$/.test(suffix)&&method==='GET');
    if(permitted)privileged={kind:'project',id:Number(id),cap};
   }
   if(privileged){
    const verify=()=>{const current=permissions();if(!current.capabilities(privileged.kind,privileged.id).includes(privileged.cap))throw fail(403,'The owner has not enabled this member permission scope');};
    verify();req.revalidateMember=verify;return next();
   }
   const check=id=>{const role=permissions().project(id);if(!role)throw fail(404,'Project not found');if(write&&role!=='editor')throw fail(403,'This project is shared with view-only access');return role;};
   const find=(sql,id)=>db.prepare(sql).get(id)?.board_id;
   const card=id=>find('SELECT l.board_id FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=?',id);
   let projectId,match;
   if(method==='GET'&&route==='/api/hierarchy'){
    const json=res.json.bind(res);res.json=value=>json(scope.filter(value));return next();
   }
   if(method==='GET'&&route==='/api/boards'){
    const json=res.json.bind(res);res.json=value=>json(value.filter(b=>scope.project(b.id)));return next();
   }
   if((match=route.match(/^\/api\/boards\/(\d+)(?:\/(.*))?$/))){
    projectId=Number(match[1]);const suffix=match[2]||'';
    const read=['','cards','activity','archived','export','files','folders','links','chat/threads','chat/context'];
    const edits=['lists','lists/reorder','labels','files','folders','file-links','links','chat/threads','agent'];
    if(write&&suffix==='agent'&&!req.personalAiAllowed)throw fail(402,'Ask the company owner to connect AI funding');
    if(method==='GET'?!read.includes(suffix):!edits.includes(suffix))throw fail(403,'This setting is managed by the account owner');
    if(method==='POST'&&suffix==='lists/reorder'&&Array.isArray(req.body?.order))for(const id of req.body.order){if(find('SELECT board_id FROM lists WHERE id=?',id)!==projectId)throw fail(404,'List not found');}
    if(method==='GET'&&!suffix){const json=res.json.bind(res);res.json=value=>json({...value,permissions:{owner:false,role:scope.project(projectId),can_ai:scope.project(projectId)==='editor',scopes:scope.capabilities('project',projectId)}});}
    if(method==='GET'&&suffix==='files'){const json=res.json.bind(res);res.json=value=>json({...value,storage:null});}
   }else if((match=route.match(/^\/api\/lists\/(\d+)(?:\/(cards))?$/))){
    if(!((method==='PATCH'&&!match[2])||(method==='POST'&&match[2]==='cards')))throw fail(403,'Action not permitted');projectId=find('SELECT board_id FROM lists WHERE id=?',match[1]);
   }else if((match=route.match(/^\/api\/cards\/(\d+)(?:\/(move|labels\/\d+|checklists|comments|attachments))?$/))){
    projectId=card(match[1]);
    if(match[2]==='move')check(find('SELECT board_id FROM lists WHERE id=?',Number(req.body?.list_id)));
    if(match[2]?.startsWith('labels/')){const labelId=match[2].split('/')[1];if(find('SELECT board_id FROM labels WHERE id=?',labelId)!==projectId)throw fail(404,'Label not found');}
   }else if((match=route.match(/^\/api\/labels\/(\d+)$/)))projectId=find('SELECT board_id FROM labels WHERE id=?',match[1]);
   else if((match=route.match(/^\/api\/checklists\/(\d+)(?:\/items)?$/)))projectId=find('SELECT l.board_id FROM checklists x JOIN cards c ON c.id=x.card_id JOIN lists l ON l.id=c.list_id WHERE x.id=?',match[1]);
   else if((match=route.match(/^\/api\/checklist-items\/(\d+)$/)))projectId=find('SELECT l.board_id FROM checklist_items i JOIN checklists x ON x.id=i.checklist_id JOIN cards c ON c.id=x.card_id JOIN lists l ON l.id=c.list_id WHERE i.id=?',match[1]);
   else if((match=route.match(/^\/api\/(comments|attachments)\/(\d+)$/)))projectId=find(`SELECT l.board_id FROM ${match[1]} x JOIN cards c ON c.id=x.card_id JOIN lists l ON l.id=c.list_id WHERE x.id=?`,match[2]);
   else if((match=route.match(/^\/api\/project-(files|links)\/(\d+)(?:\/download)?$/)))projectId=find(`SELECT board_id FROM project_${match[1]} WHERE id=?`,match[2]);
   else if((match=route.match(/^\/api\/project-folders\/(\d+)$/)))projectId=find('SELECT board_id FROM project_folders WHERE id=?',match[1]);
   else if(method==='GET'&&(match=route.match(/^\/uploads\/([^/]+)$/))){
    const filename=decodeURIComponent(req.path.slice('/uploads/'.length));
    projectId=find('SELECT l.board_id FROM attachments a JOIN cards c ON c.id=a.card_id JOIN lists l ON l.id=c.list_id WHERE a.filename=?',filename)||find('SELECT board_id FROM project_files WHERE filename=?',filename);
   }else if((match=route.match(/^\/api\/chat\/threads\/([a-f0-9-]+)(?:\/(messages))?$/))){
    projectId=find('SELECT board_id FROM chat_threads WHERE id=?',match[1]);
    if(write&&!req.personalAiAllowed)throw fail(403,'Ask the company owner to connect AI funding first');
   }else if((match=route.match(/^\/api\/boards\/(\d+)\/agent$/))){projectId=Number(match[1]);if(!req.personalAiAllowed)throw fail(403,'Ask the company owner to connect AI funding first');}
   else if((match=route.match(/^\/api\/chat\/jobs\/([a-f0-9-]+)\/(?:cancel|resume)$/))){const j=db.prepare('SELECT j.requested_by,t.board_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id WHERE j.id=?').get(match[1]);if(!j||j.requested_by!==userId)throw fail(404,'Your AI run was not found');projectId=j.board_id;}
   else if(method==='GET'&&route==='/api/chat/status')return next();
   else throw fail(403,'This action is managed by the account owner');
   if(projectId==null)throw fail(404,'Project resource not found');check(projectId);
   req.revalidateMember=()=>check(projectId);
   const actor=memberships.actor(ownerId,userId);if(req.body&&route.endsWith('/comments'))req.body.author=actor?.name||actor?.email||'Member';
   next();
  }catch(e){res.status(e.status||400).json({error:e.message||'Invalid project request'});}
 });return router;
}
module.exports={accessForMember,memberGuard};
