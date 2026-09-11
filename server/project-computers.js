const express=require('express');
const {accessForMember}=require('./member-access');
const fail=(status,message)=>Object.assign(Error(message),{status});
function installComputers(db){
 // Preserve old availability requests for history; this is no longer a catalog.
 db.exec(`CREATE TABLE IF NOT EXISTS project_computer_requests (
  board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 32),requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','cancelled')),
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
}
function createComputerRoutes({memberships}){
 const router=express.Router(),base='/api/boards/:boardId/computers';
 function access(req,write=false){
  const db=req.tenant.app.db,id=Number(req.params.boardId);
  if(!Number.isSafeInteger(id)||!db.prepare('SELECT id FROM boards WHERE id=?').get(id))throw fail(404,'Project not found');
  if(!req.workspaceIsOwner){
   const scope=accessForMember(db,memberships.grants(req.workspaceOwnerId,req.cloudUserId));
   if(!scope.project(id))throw fail(404,'Project not found');
   if(write||!scope.capabilities('project',id).includes('computers'))throw fail(403,'The owner must enable your Computer use permission.');
  }
  return{db,id};
 }
 async function state(req){
  const {db,id}=access(req),service=req.tenant.computeruse,assignment=service.assignment('project',id),valid=()=>access(req);
  const computers=assignment.saved?(await service.rentals(valid)).filter(r=>assignment.rental_ids.includes(r.id)):[];
  valid();const current=service.assignment('project',id);
  if(JSON.stringify(current)!==JSON.stringify(assignment))throw fail(409,'Computer assignment changed. Refresh and retry.');
  const companyId=db.prepare('SELECT b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(id)?.company_id??null;
  return{source:'computeruse_api',plan:null,launch_status:assignment.saved?'connected':'not_connected',checkout_available:false,can_request:false,available_computers:computers.filter(c=>c.state==='active'&&c.available===true).length,computers,assignment,company_id:companyId,manage_url:companyId?`#/company/${companyId}`:'#/',request:db.prepare("SELECT quantity,status,created_at,updated_at FROM project_computer_requests WHERE board_id=? AND status='requested'").get(id)||null};
 }
 router.get(base,async(req,res,next)=>{try{res.set('Cache-Control','private, no-store').json(await state(req));}catch(e){next(e);}});
 router.put(base+'/request',express.json({limit:'4kb'}),(req,res,next)=>{try{access(req,true);throw fail(410,'Computer availability requests have been replaced by the ComputerUse API. Refresh Boardly, connect on Companies home, then assign computers inside a company.');}catch(e){next(e);}});
 router.delete(base+'/request',async(req,res,next)=>{try{const {db,id}=access(req,true);db.prepare("UPDATE project_computer_requests SET status='cancelled',updated_at=? WHERE board_id=?").run(Date.now(),id);res.json(await state(req));}catch(e){next(e);}});
 router.post(base+'/checkout',(req,res,next)=>{try{access(req,true);throw fail(410,'Manage rentals at ComputerUse. Boardly assigns computers from your connected API account; this endpoint does not charge you.');}catch(e){next(e);}});
 return router;
}
module.exports={installComputers,createComputerRoutes};
