const express = require('express');
const crypto = require('node:crypto');
const { MAX_AGENTS, snapshot, modeInstruction, cleanValues } = require('./agent-scheduling');
const { safeText } = require('./agent-activity');
const fail = (status, message) => Object.assign(Error(message), {status});
function createOrganizationAgents({db, clean, userId, hosted, githubContext}) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_swarms (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id INTEGER NOT NULL,
    title TEXT NOT NULL, instruction TEXT NOT NULL, requested_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS discussion_threads (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id INTEGER NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS discussion_jobs (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
    mode TEXT NOT NULL, prompt TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    error TEXT, worker_id TEXT, requested_by TEXT NOT NULL, runtime TEXT NOT NULL,
    created_at INTEGER NOT NULL, started_at INTEGER, updated_at INTEGER NOT NULL);`);
  const router = express.Router();
  // Repository commits have a separately bounded body parser in project-chat.
  router.use((req,res,next)=>/^\/api\/worker\/jobs\/[^/]+\/github\//.test(req.path)?next('router'):next());
  router.use(express.json({limit:'1mb'}));
  router.get('/api/agents/companies/dashboard',(req,res)=>res.json(require('./company-overview').companyOverview(db,clean)));
  router.get('/api/agents/company/:id/dashboard',(req,res)=>{
    const s=scope('company',req.params.id),ids=s.projects.map(p=>p.id);
    const boards=db.prepare('SELECT id,name FROM company_boards WHERE company_id=? ORDER BY name').all(s.id);
    const agents=db.prepare(`SELECT j.id,j.status,j.mode,j.progress,j.error,j.swarm_id,j.created_at,j.started_at,j.updated_at,t.board_id AS project_id,t.title,t.card_id
      FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id JOIN company_projects p ON p.workspace_id=t.board_id JOIN company_boards b ON b.id=p.parent_board_id
      WHERE b.company_id=? AND (j.status IN ('queued','running','blocked','recovering') OR (j.status IN ('failed','interrupted') AND j.updated_at>?)) ORDER BY j.updated_at DESC LIMIT 100`).all(s.id,Date.now()-86400000);
    const discussions=db.prepare(`SELECT j.id,j.status,j.mode,j.prompt AS title,j.updated_at FROM discussion_jobs j JOIN discussion_threads t ON t.id=j.thread_id
      WHERE t.scope_type='company' AND t.scope_id=? AND j.status IN ('queued','running') ORDER BY j.created_at`).all(s.id);
    const blockers=db.prepare(`SELECT c.id,c.title,c.description,c.due_date,c.updated_at,p.workspace_id AS project_id,p.name AS project_name,b.id AS board_id,b.name AS board_name,
      (SELECT body FROM comments WHERE card_id=c.id ORDER BY id DESC LIMIT 1) AS latest_update
      FROM cards c JOIN lists l ON l.id=c.list_id JOIN company_projects p ON p.workspace_id=l.board_id JOIN company_boards b ON b.id=p.parent_board_id
      WHERE b.company_id=? AND c.archived=0 AND l.archived=0 AND lower(trim(l.name))='blocked' ORDER BY c.updated_at DESC LIMIT 100`).all(s.id);
    res.json(cleanValues({company:{id:s.id,name:s.name},boards,projects:s.projects.map(p=>({...p,board_id:db.prepare('SELECT parent_board_id FROM company_projects WHERE workspace_id=?').get(p.id).parent_board_id})),agents,discussions,blockers,updated_at:Date.now()},value=>scrub(s,value)));
  });
  function scope(kind,id) {
    if (!['company','board'].includes(kind) || !Number.isSafeInteger(Number(id))) throw fail(400,'Choose a company or board');
    require('./hierarchy').ensureProjects(db);
    const row = db.prepare(`SELECT id,name FROM ${kind==='company'?'companies':'company_boards'} WHERE id=?`).get(id);
    if (!row) throw fail(404,'Company or board not found');
    const projects = db.prepare(`SELECT p.workspace_id AS id,p.name,b.name AS board_name FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE ${kind==='company'?'b.company_id':'b.id'}=? ORDER BY b.name,p.name`).all(id);
    return {...row,kind,projects};
  }
  const scrub = (s,text) => s.projects.reduce((v,p)=>clean(p.id,v),safeText(text));
  const getThread = id => { const t=db.prepare('SELECT * FROM discussion_threads WHERE id=?').get(id);if(!t)throw fail(404,'Conversation not found');scope(t.scope_type,t.scope_id);return t; };
  function details(id) {
    const swarm=db.prepare('SELECT * FROM agent_swarms WHERE id=?').get(id);if(!swarm)throw fail(404,'Swarm not found');scope(swarm.scope_type,swarm.scope_id);
    const agents=db.prepare(`SELECT j.id,j.thread_id,j.status,j.progress,j.error,j.created_at,j.started_at,j.updated_at,t.board_id AS project_id,t.title,p.name AS project_name,b.name AS board_name
      FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id JOIN company_projects p ON p.workspace_id=t.board_id JOIN company_boards b ON b.id=p.parent_board_id WHERE j.swarm_id=? ORDER BY j.created_at,j.rowid`).all(id);
    return {...swarm,agents,max_agents:MAX_AGENTS};
  }
  router.get('/api/agents/:kind(company|board)/:id', (req,res) => {
    const s=scope(req.params.kind,req.params.id);
    const swarms=db.prepare('SELECT id FROM agent_swarms WHERE scope_type=? AND scope_id=? ORDER BY created_at DESC LIMIT 20').all(s.kind,s.id).map(x=>details(x.id));
    const threads=db.prepare('SELECT * FROM discussion_threads WHERE scope_type=? AND scope_id=? ORDER BY created_at DESC,rowid DESC').all(s.kind,s.id);
    res.json({scope:s,swarms,threads,max_agents:MAX_AGENTS,github:s.projects.map(p=>({project_id:p.id,project_name:p.name,board_name:p.board_name,...githubContext?.(req.cloudUserId||userId,p.id)}))});
  });
  router.post('/api/agents/:kind(company|board)/:id/swarms', (req,res) => {
    const s=scope(req.params.kind,req.params.id), data=req.body;
    if(data.mode!=='work')throw fail(400,'Choose Work mode to start agents');
    if(typeof data.request_key!=='string'||!/^[a-f0-9-]{36}$/.test(data.request_key))throw fail(400,'A launch request ID is required');
    const prior=db.prepare('SELECT * FROM agent_swarms WHERE id=?').get(data.request_key);
    if(prior){if(prior.scope_type!==s.kind||prior.scope_id!==s.id)throw fail(409,'Launch ID already used');return res.json(details(prior.id));}
    if(typeof data.instruction!=='string'||!data.instruction.trim()||data.instruction.length>30000)throw fail(400,'Describe the work for this swarm');
    if(!Array.isArray(data.assignments)||!data.assignments.length||data.assignments.length>50)throw fail(400,'Choose between 1 and 50 project agents');
    const ids=new Set();
    for(const a of data.assignments){if(!s.projects.some(p=>p.id===a.project_id)||ids.has(a.project_id))throw fail(400,'Choose each project once within this scope');ids.add(a.project_id);if(typeof a.instruction!=='string'||a.instruction.length>10000)throw fail(400,'Invalid agent assignment');}
    const now=Date.now(),actor=req.cloudUserId||userId;
    db.transaction(()=>{
      db.prepare('INSERT INTO agent_swarms VALUES (?,?,?,?,?,?,?)').run(data.request_key,s.kind,s.id,scrub(s,data.instruction.trim()).slice(0,120),scrub(s,data.instruction.trim()),actor,now);
      for(const a of data.assignments){
        const tid=crypto.randomUUID(),mid=crypto.randomUUID(),jid=crypto.randomUUID(),p=s.projects.find(p=>p.id===a.project_id);
        const content=clean(p.id,`Work as the agent for ${p.board_name} / ${p.name} in the ${s.name} swarm. Shared objective: ${data.instruction.trim()}\nYour assignment: ${a.instruction.trim()||'Apply the shared objective to this project.'}\nWork only in this project. Read its tasks first, preserve existing context, verify results and update the relevant task. Other project agents run independently; do not start work on their projects.`);
        db.prepare('INSERT INTO chat_threads(id,board_id,title,created_at) VALUES (?,?,?,?)').run(tid,p.id,'Swarm: '+data.instruction.trim().slice(0,90),now);
        db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run(mid,tid,'user',content,now);
        db.prepare("INSERT INTO chat_jobs(id,thread_id,message_id,status,created_at,updated_at,runtime,requested_by,mode,swarm_id) VALUES (?,?,?,'queued',?,?,?,?,'work',?)").run(jid,tid,mid,now,now,req.aiRuntime||'codex',actor,data.request_key);
      }
    }).immediate();
    if(req.aiRuntime==='api')hosted().enqueue();res.status(202).json(details(data.request_key));
  });
  router.post('/api/swarms/:id/cancel',(req,res)=>{details(req.params.id);db.prepare("UPDATE chat_jobs SET status='cancelled',progress='Swarm stopped',updated_at=? WHERE swarm_id=? AND status IN ('queued','running')").run(Date.now(),req.params.id);res.json(details(req.params.id));});
  router.post('/api/agents/:kind(company|board)/:id/threads',(req,res)=>{const s=scope(req.params.kind,req.params.id),id=crypto.randomUUID();db.prepare('INSERT INTO discussion_threads VALUES (?,?,?,?,?)').run(id,s.kind,s.id,scrub(s,String(req.body?.title||'New conversation').trim().slice(0,100))||'New conversation',Date.now());res.status(201).json(getThread(id));});
  router.get('/api/discussions/threads/:id',(req,res)=>{const t=getThread(req.params.id);res.json({thread:t,runs:db.prepare('SELECT id,mode,prompt,draft,status,error,created_at,started_at,updated_at FROM discussion_jobs WHERE thread_id=? ORDER BY created_at,rowid').all(t.id)});});
  router.post('/api/discussions/threads/:id/messages',(req,res)=>{
    const t=getThread(req.params.id),s=scope(t.scope_type,t.scope_id),{content,mode}=req.body;
    if(!['ask','plan'].includes(mode))throw fail(400,'Choose Ask or Plan. Use the Work tab to launch project agents.');
    if(typeof content!=='string'||!content.trim()||content.length>30000)throw fail(400,'Enter a message up to 30000 characters');
    if(db.prepare("SELECT id FROM discussion_jobs WHERE thread_id=? AND status IN ('queued','running')").get(t.id))throw fail(409,'Wait for this reply or stop it first');
    const id=crypto.randomUUID(),now=Date.now();
    db.prepare("INSERT INTO discussion_jobs(id,thread_id,mode,prompt,status,requested_by,runtime,created_at,updated_at) VALUES (?,?,?,?,'queued',?,?,?,?)").run(id,t.id,mode,scrub(s,content.trim()),req.cloudUserId||userId,req.aiRuntime||'codex',now,now);
    if(t.title==='New conversation')db.prepare('UPDATE discussion_threads SET title=? WHERE id=?').run(scrub(s,content.trim()).slice(0,100),t.id);
    if(req.aiRuntime==='api')router.enqueueApi?.();res.status(202).json({id});
  });
  router.post('/api/discussions/jobs/:id/cancel',(req,res)=>{const j=db.prepare('SELECT * FROM discussion_jobs WHERE id=?').get(req.params.id);if(!j)throw fail(404,'Reply not found');getThread(j.thread_id);db.prepare("UPDATE discussion_jobs SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running')").run(Date.now(),j.id);res.json({ok:true});});
  function context(j){const t=getThread(j.thread_id),s=scope(t.scope_type,t.scope_id);return {kind:'discussion',...j,context:cleanValues({scope:s,projects:snapshot(db,s.projects.map(p=>p.id),{github:githubContext&&((id)=>githubContext(j.requested_by||userId,id))})},value=>scrub(s,value)),history:db.prepare("SELECT mode,prompt,draft,status FROM discussion_jobs WHERE thread_id=? AND created_at<=? ORDER BY created_at,rowid").all(t.id,j.created_at).slice(-20)};}
  function claim(workerId){return db.transaction(()=>{const j=db.prepare("SELECT * FROM discussion_jobs WHERE status='queued' AND runtime='codex' ORDER BY created_at,rowid LIMIT 1").get();if(!j)return null;const c=context(j);db.prepare("UPDATE discussion_jobs SET status='running',worker_id=?,started_at=?,updated_at=? WHERE id=?").run(workerId,Date.now(),Date.now(),j.id);return c;}).immediate();}
  router.post('/api/worker/discussions/:id',(req,res)=>{
    const j=db.prepare('SELECT * FROM discussion_jobs WHERE id=?').get(req.params.id);if(!j||j.worker_id!==req.boardlyConnection.id)return res.status(404).json({error:'Reply not found'});
    if(j.status!=='running')return res.json({status:j.status});const t=getThread(j.thread_id),s=scope(t.scope_type,t.scope_id),d=req.body;
    const status=['completed','failed','cancelled'].includes(d.status)?d.status:'running';
    db.prepare('UPDATE discussion_jobs SET status=?,draft=?,error=?,updated_at=? WHERE id=?').run(status,scrub(s,typeof d.text==='string'?d.text.slice(0,200000):j.draft),d.error?safeText(d.error):null,Date.now(),j.id);res.json({status});
  });
  router.use((e,req,res,next)=>e.status?res.status(e.status).json({error:e.message}):next(e));
  return {router,claim,context,scope};
}
module.exports={createOrganizationAgents};
