const express=require('express');
const instruction='Continuously work through the owner-authorized To Do queue. Implement the requested deliverable, verify it and record concrete evidence. Reuse existing tasks. Task updates, plans, and delegation are not implementation. Continue independent work when another task is blocked. Do not purchase, register accounts, disclose credentials, contact third parties, or change access without the relevant owner authorization. Record the exact owner dependency when needed. Respect explicit stops, human takeover and safety boundaries. Never invent work or activity to keep an indicator moving.';
function createWorkMonitor({db,ownerId,employees}){
 db.exec(`CREATE TABLE IF NOT EXISTS work_monitor_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,instruction TEXT NOT NULL,last_checked_at INTEGER,last_error TEXT);
 CREATE TABLE IF NOT EXISTS work_monitor_projects(board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,last_checked_at INTEGER);
 INSERT OR IGNORE INTO work_monitor_settings(id,enabled,instruction) VALUES(1,0,'');`);
 const settings=()=>db.prepare('SELECT * FROM work_monitor_settings WHERE id=1').get();
 const projects=()=>db.prepare('SELECT p.workspace_id AS id,b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE b.company_id IS NOT NULL').all();
 function configureProject(id,force=false){
  employees.ensure(id);
  const prior=db.prepare('SELECT 1 FROM employee_teams WHERE board_id=?').get(id);
  if(force||!prior){const s=settings();db.prepare(`INSERT INTO employee_teams(board_id,enabled,requested_by,runtime,instruction,updated_at,ordered) VALUES(?,1,?,'api',?,?,1)
   ON CONFLICT(board_id) DO UPDATE SET enabled=1,requested_by=excluded.requested_by,runtime='api',instruction=excluded.instruction,updated_at=excluded.updated_at,ordered=1`).run(id,ownerId,instruction+'\n'+s.instruction,Date.now());}
  db.prepare('INSERT OR IGNORE INTO work_monitor_projects(board_id,last_checked_at) VALUES(?,NULL)').run(id);
 }
 function status(){const s=settings();return {...s,projects:projects().map(p=>({...p,...db.prepare('SELECT enabled,ordered FROM employee_teams WHERE board_id=?').get(p.id),...db.prepare('SELECT last_checked_at FROM work_monitor_projects WHERE board_id=?').get(p.id)}))};}
 function configure(enabled,note=''){
  if(typeof enabled!=='boolean'||typeof note!=='string'||note.length>8000)throw Object.assign(Error('Choose a monitoring state and instructions up to 8,000 characters.'),{status:400});
  db.transaction(()=>{db.prepare('UPDATE work_monitor_settings SET enabled=?,instruction=?,last_error=NULL WHERE id=1').run(Number(enabled),note);
   if(enabled)for(const p of projects())configureProject(p.id,true);
   else db.prepare('UPDATE employee_teams SET enabled=0 WHERE board_id IN (SELECT board_id FROM work_monitor_projects)').run();})();
  tick();return status();
 }
 function tick(){
  if(!settings().enabled)return;
  try{for(const p of projects())configureProject(p.id);employees.tick();const now=Date.now();db.prepare('UPDATE work_monitor_projects SET last_checked_at=?').run(now);db.prepare('UPDATE work_monitor_settings SET last_checked_at=?,last_error=NULL WHERE id=1').run(now);}
  catch{db.prepare("UPDATE work_monitor_settings SET last_error='Monitor check failed; automatic retry on the next check.' WHERE id=1").run();}
 }
 const router=express.Router();router.use('/api/work-monitor',(req,res,next)=>{if(req.cloudUserId!==ownerId||!req.workspaceIsOwner||(req.boardlyConnection&&!req.boardlyManagement))return res.status(403).json({error:'Only the workspace owner can manage continuous monitoring.'});next();});
 router.get('/api/work-monitor',(_req,res)=>res.json(status()));
 router.put('/api/work-monitor',express.json({limit:'16kb'}),(req,res,next)=>{try{res.json(configure(req.body.enabled,req.body.instruction||''));}catch(e){next(e);}});
 return {router,status,configure,tick};
}
module.exports={createWorkMonitor};
