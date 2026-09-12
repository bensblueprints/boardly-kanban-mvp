const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const { safeText } = require('./agent-activity');
const { MAX_AGENTS, nextProjectJob, projectQueue, snapshot, cleanValues } = require('./agent-scheduling');

function createProjectChat({ db, connections, userId, uploadsDir, environment, payments, email, ssh, github, computeruse, media, canUseMedia=(actor)=>actor===userId, canUseComputers=(actor)=>actor===userId, canUseGithub=(actor)=>actor===userId, canUseSsh=(actor)=>actor===userId }) {
  const router = express.Router();
  db.exec(`CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL, codex_session_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_jobs (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, status TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '',
    draft TEXT NOT NULL DEFAULT '', error TEXT, worker_id TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_activity (
    job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE, event_key TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(job_id,event_key)
  );`);
  if (!db.prepare('PRAGMA table_info(chat_jobs)').all().some(c => c.name === 'started_at')) db.exec('ALTER TABLE chat_jobs ADD COLUMN started_at INTEGER');
  if (!db.prepare('PRAGMA table_info(chat_threads)').all().some(c => c.name === 'card_id')) db.exec('ALTER TABLE chat_threads ADD COLUMN card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS chat_scope ON chat_threads(board_id,card_id,created_at)');
  if (!db.prepare('PRAGMA table_info(chat_jobs)').all().some(c => c.name === 'company_id')) db.exec('ALTER TABLE chat_jobs ADD COLUMN company_id INTEGER');
  for (const [name,type] of [['runtime',"TEXT NOT NULL DEFAULT 'codex'"],['requested_by','TEXT'],['billing_owner_id','TEXT']]) if (!db.prepare('PRAGMA table_info(chat_jobs)').all().some(c=>c.name===name)) db.exec(`ALTER TABLE chat_jobs ADD COLUMN ${name} ${type}`);
  for (const [name,type] of [['mode',"TEXT NOT NULL DEFAULT 'work'"],['swarm_id','TEXT'],['settled_at','INTEGER']]) if (!db.prepare('PRAGMA table_info(chat_jobs)').all().some(c=>c.name===name)) db.exec(`ALTER TABLE chat_jobs ADD COLUMN ${name} ${type}`);
  for(const [name,type] of [['worker_host',"TEXT NOT NULL DEFAULT 'desktop'"],['continuation_count','INTEGER NOT NULL DEFAULT 0'],['recovery_required','INTEGER NOT NULL DEFAULT 0'],['blocker_card_id','INTEGER REFERENCES cards(id) ON DELETE SET NULL'],['blocker','TEXT'],['next_action','TEXT'],['resume_note','TEXT']])if(!db.prepare('PRAGMA table_info(chat_jobs)').all().some(c=>c.name===name))db.exec(`ALTER TABLE chat_jobs ADD COLUMN ${name} ${type}`);
  const blockers=require('./agent-blockers').createAgentBlockers(db);
  const hierarchy = require('./hierarchy').createHierarchy(db);
  const task = (boardId, cardId) => cardId == null ? null : db.prepare('SELECT c.id,c.title,c.description FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=?').get(cardId, boardId);
  const clean = (boardId, text) => { const value = ssh ? ssh.redact(cleanBase(boardId,text)) : cleanBase(boardId,text); return safeText(github ? github.redact(value) : value); };
  const cleanBase = (boardId,text) => safeText(email ? email.clean(cleanProject(boardId,text)) : cleanProject(boardId,text));
  const cleanProject = (boardId, text) => safeText(payments ? payments.redact(boardId, environment ? environment.redact(boardId, text) : text) : environment ? environment.redact(boardId, text) : text);
  const thread = id => db.prepare('SELECT * FROM chat_threads WHERE id=?').get(id);
  const job = id => db.prepare('SELECT * FROM chat_jobs WHERE id=?').get(id);
  const busy = id => db.prepare("SELECT * FROM chat_jobs WHERE thread_id=? AND status IN ('queued','running','recovering')").get(id);
  const message = (threadId, role, content) => db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), threadId, role, content, Date.now());
  const body = express.json({ limit: '1mb' });
  const githubContext=(actor,id)=>canUseGithub(actor,id)?github?.context(id)||{status:'not_connected',saved:false}:{status:'restricted',saved:null};
  const sshContext=(actor,id)=>canUseSsh(actor,id)?ssh?.context?.(id,actor)||{status:'not_connected',saved:false,connections:[]}:{status:'restricted',saved:null,connections:[]};
  const computerContext=(actor,id)=>canUseComputers(actor,id)?computeruse?.assignment('project',id)||{configured:false,saved:false,rental_ids:[],allow_agent:false,allow_control:false}:{status:'restricted',saved:null,rental_ids:[]};
  const organization = require('./organization-agents').createOrganizationAgents({db,clean,userId,hosted:()=>router.hosted,githubContext,sshContext,computerContext});
  router.organization=organization; router.use(organization.router);
  router.audioWork=require('./audio-work').createAudioWork({db,userId,clean,enqueue:()=>router.hosted.enqueue()});
  function expireJobs() {
    db.prepare("UPDATE chat_jobs SET status='interrupted',error='Codex worker disconnected. Review the result before sending another message.',updated_at=? WHERE status='running' AND updated_at<?")
      .run(Date.now(), Date.now() - 7 * 86400000);
    db.prepare("UPDATE discussion_jobs SET status='interrupted',error='Worker disconnected for seven days. Send another message to continue.',updated_at=? WHERE status='running' AND updated_at<?").run(Date.now(),Date.now()-7*86400000);
  }
  router.post('/api/boards/:boardId/agent', body, (req, res) => {
    const board = db.prepare('SELECT * FROM boards WHERE id=?').get(req.params.boardId);
    if (!board) return res.status(404).json({ error: 'Project not found' });
    const cardId = req.body?.card_id;
    const card = cardId == null ? null : db.prepare('SELECT c.* FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=?').get(cardId, board.id);
    if (cardId != null && !card) return res.status(404).json({ error: 'Task does not belong to this project' });
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim().slice(0, 30000) : '';
    const content = (card ? `Work on Boardly task ${card.id}: ${card.title}. Read its description and checklists before acting.` : 'Review this project and work on its highest-priority actionable task.') +
      '\nFollow the project workflow, make the authorized changes, verify the result and update Boardly. Record real blockers and continue independent work.\n' + instruction;
    const existing = db.prepare('SELECT * FROM chat_threads WHERE board_id=? AND card_id IS ? ORDER BY created_at DESC LIMIT 1').get(board.id, cardId || null);
    expireJobs();
    if (existing && busy(existing.id)) return res.status(409).json({ error: 'This conversation already has an active run' });
    const id = existing?.id || crypto.randomUUID(), mid = crypto.randomUUID(), jid = crypto.randomUUID(), now = Date.now();
    db.transaction(() => {
      if (!existing) db.prepare('INSERT INTO chat_threads (id,board_id,card_id,title,created_at) VALUES (?,?,?,?,?)').run(id, board.id, cardId || null, ('Agent: ' + (card?.title || board.name)).slice(0,120), now);
      db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run(mid, id, 'user', clean(board.id, content), now);
      db.prepare("INSERT INTO chat_jobs (id,thread_id,message_id,status,created_at,updated_at) VALUES (?,?,?,'queued',?,?)").run(jid, id, mid, now, now);
    })();
    db.prepare('UPDATE chat_jobs SET runtime=?,requested_by=?,billing_owner_id=? WHERE id=?').run(req.aiRuntime||'codex',req.cloudUserId||userId,userId,jid);
    if(req.aiRuntime==='api')router.hosted.enqueue();
    res.status(202).json({ threadId: id, jobId: jid });
  });
  router.get('/api/chat/status', (req, res) => {
    expireJobs();
    if(req.aiRuntime==='api')return res.json({online:!!req.personalAiAllowed,message:req.aiFunding==='owner_subscription'?'AI uses the company owner’s connected subscription. Your permission scopes still apply.':'AI usage is funded by the company owner. Activity and results are saved in this project.',personal_ai:true,funding:req.aiFunding||'owner_api'});
    const workers = connections.list(userId).filter(c => c.scope === 'worker' && !c.revoked_at && c.expires_at > Date.now());
    res.json({ online: workers.some(c => c.last_used_at > Date.now() - 45000),
      cloud:workers.some(c=>c.name.startsWith('Cloud agent')&&c.last_used_at>Date.now()-45000),max_agents:MAX_AGENTS,message:'Up to four agents work through assigned objectives. Progress and blockers are saved with this project.' });
  });
  router.get('/api/boards/:boardId/chat/threads', (req, res) => {
    if (!db.prepare('SELECT id FROM boards WHERE id=?').get(req.params.boardId)) return res.status(404).json({ error: 'Project not found' });
    expireJobs();
    const cardId = req.query.card_id == null ? null : Number(req.query.card_id);
    if (cardId !== null && (!Number.isSafeInteger(cardId) || !task(req.params.boardId, cardId))) return res.status(404).json({ error: 'Task does not belong to this project' });
    res.json(db.prepare(`SELECT t.id,t.board_id,t.card_id,t.title,t.created_at,j.status AS job_status,j.mode AS job_mode
      FROM chat_threads t LEFT JOIN chat_jobs j ON j.id=(SELECT id FROM chat_jobs WHERE thread_id=t.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      WHERE t.board_id=? AND t.card_id IS ? ORDER BY t.created_at DESC,t.rowid DESC`).all(req.params.boardId, cardId));
  });
  router.get('/api/boards/:boardId/chat/context',(req,res)=>{
    const id=Number(req.params.boardId),actor=req.cloudUserId||userId;
    if(!db.prepare('SELECT id FROM boards WHERE id=?').get(id))return res.status(404).json({error:'Project not found'});
    res.json({ssh:sshContext(actor,id),can_manage_ssh:canUseSsh(actor,id),github:githubContext(actor,id),can_manage_github:canUseGithub(actor,id),scope:hierarchy.scope(id)});
  });
  router.post('/api/boards/:boardId/chat/threads', body, (req, res) => {
    if (!db.prepare('SELECT id FROM boards WHERE id=?').get(req.params.boardId)) return res.status(404).json({ error: 'Project not found' });
    const cardId = req.body?.card_id ?? null;
    if (cardId !== null && (!Number.isSafeInteger(cardId) || !task(req.params.boardId, cardId))) return res.status(404).json({ error: 'Task does not belong to this project' });
    const id = crypto.randomUUID();
    const title = clean(req.params.boardId, String(req.body?.title || 'New conversation').trim().slice(0, 120)) || 'New conversation';
    db.prepare('INSERT INTO chat_threads (id,board_id,card_id,title,created_at) VALUES (?,?,?,?,?)').run(id, req.params.boardId, cardId, title, Date.now());
    res.status(201).json(thread(id));
  });
  router.get('/api/chat/threads/:id', (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Conversation not found' });
    expireJobs();
    const runs = db.prepare('SELECT id,message_id,mode,status,progress,draft,error,created_at,started_at,updated_at,worker_host,continuation_count,blocker_card_id,blocker,next_action FROM chat_jobs WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(t.id);
    for (const run of runs) {
      run.activity = db.prepare('SELECT event_key AS key,kind,title,detail,status,created_at,updated_at FROM chat_activity WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(run.id).reverse();
      if (run.status === 'queued') run.queue = projectQueue(db, run.id);
    }
    res.json({ thread: t, task: task(t.board_id, t.card_id), messages: db.prepare('SELECT * FROM chat_messages WHERE thread_id=? ORDER BY created_at,rowid').all(t.id),
      job: runs[0] || null, runs });
  });
  router.post('/api/chat/threads/:id/messages', body, (req, res) => {
    const t = thread(req.params.id), content = req.body?.content;
    const mode = req.body?.mode ?? 'ask';
    if (!['ask','plan','work'].includes(mode)) return res.status(400).json({error:'Choose Ask, Plan or Work'});
    if (!t) return res.status(404).json({ error: 'Conversation not found' });
    if (typeof content !== 'string' || !content.trim() || content.length > 30000) return res.status(400).json({ error: 'Enter a message up to 30000 characters' });
    expireJobs();
    if (busy(t.id)) return res.status(409).json({ error: 'Wait for this run to finish or stop it first' });
    const id = crypto.randomUUID(), mid = crypto.randomUUID(), now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run(mid, t.id, 'user', clean(t.board_id, content.trim()), now);
      db.prepare("INSERT INTO chat_jobs (id,thread_id,message_id,status,created_at,updated_at) VALUES (?,?,?,'queued',?,?)").run(id, t.id, mid, now, now);
      if (t.title === 'New conversation') db.prepare('UPDATE chat_threads SET title=? WHERE id=?').run(clean(t.board_id, content.trim()).slice(0, 80), t.id);
    })();
    db.prepare('UPDATE chat_jobs SET runtime=?,requested_by=?,mode=?,billing_owner_id=? WHERE id=?').run(req.aiRuntime||'codex',req.cloudUserId||userId,mode,userId,id);
    if(req.aiRuntime==='api')router.hosted.enqueue();
    res.status(202).json({ id, status: 'queued' });
  });
  router.post('/api/chat/jobs/:id/resume', body, (req,res)=>{
    const j=job(req.params.id);if(!j||j.mode!=='work'||!['blocked','failed','interrupted'].includes(j.status))return res.status(409).json({error:'Choose a paused Work assignment'});if(busy(j.thread_id))return res.status(409).json({error:'This conversation already has active work'});
    const content=typeof req.body?.content==='string'?req.body.content.trim().slice(0,10000):'';const t=thread(j.thread_id);
    const note=clean(t.board_id,content||'The blocker has been resolved. Re-check the dependency and continue the assigned objective.');message(j.thread_id,'user',note);db.prepare('UPDATE chat_jobs SET resume_note=? WHERE id=?').run(note,j.id);
    blockers.resumed(j);db.prepare("UPDATE chat_jobs SET status='queued',worker_id=NULL,error=NULL,settled_at=NULL,recovery_required=1,progress='Resuming assigned work',updated_at=? WHERE id=?").run(Date.now(),j.id);
    if(j.runtime==='api')router.hosted.enqueue();res.json({id:j.id,status:'queued'});
  });
  router.post('/api/chat/jobs/:id/cancel', (req, res) => {
    const j = job(req.params.id);
    if (!j) return res.status(404).json({ error: 'Run not found' });
    db.prepare("UPDATE chat_jobs SET status='cancelled',progress='Stop requested',updated_at=? WHERE id=? AND status IN ('queued','running')").run(Date.now(), j.id);
    res.json({ ok: true });
  });
  router.post('/api/worker/reconnect', body, (req,res)=>{
    const now=Date.now(),id=req.boardlyConnection.id;
    if(req.body?.recover===true)db.prepare("UPDATE chat_jobs SET status='queued',worker_id=NULL,recovery_required=1,progress='Recovering cloud assignment',updated_at=? WHERE worker_id=? AND worker_host='cloud' AND mode='work' AND status IN ('running','recovering')").run(now,id);
    db.prepare("UPDATE chat_jobs SET status='interrupted',error='The worker restarted. Saved conversation and changes are retained; send a follow-up to continue.',settled_at=?,updated_at=? WHERE worker_id=? AND status='running'").run(now,now,id);
    db.prepare("UPDATE chat_jobs SET settled_at=? WHERE worker_id=? AND status='cancelled' AND settled_at IS NULL").run(now,id);
    db.prepare("UPDATE discussion_jobs SET status='interrupted',error='The worker restarted. Send a follow-up to continue.',updated_at=? WHERE worker_id=? AND status='running'").run(now,id);
    res.json({ok:true});
  });
  router.post('/api/worker/claim', body, (req, res) => {
    expireJobs();
    const selected = db.transaction(() => {
      const count=db.prepare("SELECT (SELECT COUNT(*) FROM chat_jobs WHERE status='running' AND runtime='codex') + (SELECT COUNT(*) FROM discussion_jobs WHERE status='running' AND runtime='codex') AS n").get().n;
      if(count>=MAX_AGENTS)return null;
      const discussion=organization.claim(req.boardlyConnection.id);if(discussion)return discussion;
      const j = nextProjectJob(db,'codex');
      if (!j) return null;
      db.prepare("UPDATE chat_jobs SET status='running',worker_id=?,progress='Opening project in Codex',started_at=?,updated_at=? WHERE id=?").run(req.boardlyConnection.id, Date.now(), Date.now(), j.id);
      blockers.started(j);
      db.prepare('UPDATE chat_jobs SET worker_host=? WHERE id=?').run(req.body?.cloud===true?'cloud':'desktop',j.id);
      const t = thread(j.thread_id);
      require('./hierarchy').ensureProjects(db);
      const scope = hierarchy.scope(t.board_id);
      db.prepare('UPDATE chat_jobs SET company_id=? WHERE id=?').run(scope?.company_id ?? null,j.id);
      if(j.mode!=='work')return {...j,status:'running',context:cleanValues(snapshot(db,[t.board_id],{github:id=>githubContext(j.requested_by||userId,id),ssh:id=>sshContext(j.requested_by||userId,id),computers:id=>computerContext(j.requested_by||userId,id)}),value=>clean(t.board_id,value)),history:db.prepare('SELECT role,content FROM chat_messages WHERE thread_id=? ORDER BY created_at,rowid').all(t.id).slice(-40),prompt:db.prepare('SELECT content FROM chat_messages WHERE id=?').get(j.message_id).content};
      return { ...j, status: 'running', sessionId: t.codex_session_id,
        board: db.prepare('SELECT id,uuid,name,description FROM boards WHERE id=?').get(t.board_id),
        hierarchy: scope,
        media: canUseMedia(j.requested_by||userId,t.board_id)&&!!media?.forAgent(t.board_id).length,
        computeruse: canUseComputers(j.requested_by||userId,t.board_id)&&!!computeruse?.enabled(t.board_id),
        emails: email?.agentList(t.board_id) || [],
        ssh: canUseSsh(j.requested_by||userId,t.board_id)?ssh?.agentList(t.board_id,j.requested_by||userId)||[]:[],
        github: github?.agentList(t.board_id)||[],
        task: task(t.board_id, t.card_id),
        environment: environment?.values(t.board_id) || {},
        payments: payments?.summary(t.board_id) || null,
        history: db.prepare('SELECT role,content FROM chat_messages WHERE thread_id=? ORDER BY created_at,rowid').all(t.id).slice(-40),
        files: require('./project-folders').listFiles(db,t.board_id).map(({id,uuid,name,url,size,folder_id,folder_path})=>({id,uuid,name,url,size,folder_id,folder_path})),
        links: db.prepare('SELECT title,url,description FROM project_links WHERE board_id=?').all(t.board_id),
        prompt: db.prepare('SELECT content FROM chat_messages WHERE id=?').get(j.message_id).content+(j.resume_note?'\nLatest user clarification: '+j.resume_note:'') };
    })();
    res.json({ job: selected });
  });
  function activeJob(req, res, next) {
    const j = job(req.params.id);
    if (!j || j.mode !== 'work' || j.worker_id !== req.boardlyConnection.id || j.status !== 'running') return res.status(404).json({ error: 'Active run not found' });
    req.projectJob = j; req.projectThread = thread(j.thread_id); next();
  }
  router.post('/api/worker/jobs/:id/media/:action',activeJob,express.json({limit:'12kb'}),async(req,res,next)=>{try{
    const actor=req.projectJob.requested_by||userId,boardId=req.projectThread.board_id;
    const valid=()=>{const current=job(req.params.id);if(!media||!canUseMedia(actor,boardId)||current?.status!=='running'||current.worker_id!==req.boardlyConnection.id||current.updated_at<Date.now()-120000)throw Object.assign(Error('Media permission or active run was removed'),{status:403});};
    valid();res.set('Cache-Control','no-store');const action=req.params.action,data=req.body||{};
    if(action==='list')return res.json(media.forAgent(boardId));
    if(action==='generate')return res.json(await media.generate(boardId,actor,data,valid));
    if(['status','cancel'].includes(action))return res.json(await media.refresh(boardId,data.job_id,valid,action==='cancel'));
    throw Object.assign(Error('Unknown media action'),{status:404});
  }catch(e){next(e);}});
  router.post('/api/worker/jobs/:id/computeruse/:action',activeJob,express.json({limit:'25kb'}),async(req,res,next)=>{try{
    const actor=req.projectJob.requested_by||userId,boardId=req.projectThread.board_id;
    const valid=()=>{const current=job(req.params.id);if(!computeruse||!canUseComputers(actor,boardId)||!computeruse.enabled(boardId)||current?.status!=='running'||current.worker_id!==req.boardlyConnection.id||current.updated_at<Date.now()-120000)throw Object.assign(Error('Computer use permission or active run was removed'),{status:403});};
    valid();res.setHeader('cache-control','no-store');
    if(req.params.action==='release-all'){await computeruse.releaseRun(req.projectJob.id);return res.json({released:true});}
    if(req.params.action==='list')return res.json(await computeruse.inspectForAgent(boardId,actor,valid));
    res.json(await computeruse.controlForAgent(boardId,actor,req.projectJob.id,req.params.action,req.body||{},valid));
  }catch(e){next(e);}});
  router.post('/api/worker/jobs/:id/github/:connectionId/:action',activeJob,express.json({limit:'8mb'}),async(req,res,next)=>{
    try {
      if(!github)return res.status(503).json({error:'GitHub is unavailable'});
      const valid=()=>{const current=job(req.params.id),actor=req.projectJob.requested_by||userId;return canUseGithub(actor,req.projectThread.board_id)&&(req.params.action!=='deploy'||canUseSsh(actor,req.projectThread.board_id))&&current?.status==='running'&&current.worker_id===req.boardlyConnection.id;};
      const result=await github.run({projectId:req.projectThread.board_id,companyId:req.projectJob.company_id,connectionId:req.params.connectionId,action:req.params.action,data:req.body,valid,ssh,actor:req.projectJob.requested_by||userId});
      res.setHeader('cache-control','no-store');res.json(result);
    }catch(e){next(e);}
  });
  router.post('/api/worker/jobs/:id/ssh/:connectionId',activeJob,(req,res)=>{
    if(!ssh)return res.status(503).json({error:'SSH unavailable'});
    try{const actor=req.projectJob.requested_by||userId;if(!canUseSsh(actor,req.projectThread.board_id))throw Object.assign(Error('SSH permission was removed'),{status:403});res.setHeader('cache-control','no-store');res.json(ssh.forJob(req.projectThread.board_id,req.projectJob.company_id,req.params.connectionId,actor));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'SSH unavailable'});}
  });
  router.post('/api/worker/jobs/:id/ssh/:connectionId/exec',activeJob,body,async(req,res,next)=>{try{
    if(!ssh||typeof req.body?.command!=='string'||!req.body.command.trim()||req.body.command.length>30000)return res.status(400).json({error:'Enter an SSH command'});
    const actor=req.projectJob.requested_by||userId,config=ssh.forJob(req.projectThread.board_id,req.projectJob.company_id,req.params.connectionId,actor);
    const valid=()=>{try{const current=job(req.params.id);return canUseSsh(actor,req.projectThread.board_id)&&current?.status==='running'&&current.worker_id===req.boardlyConnection.id&&ssh.forJob(req.projectThread.board_id,req.projectJob.company_id,config.id,actor).updated_at===config.updated_at;}catch{return false;}};
    res.setHeader('cache-control','no-store');res.json(await ssh.execute(config,{requireEnabled:true,command:req.body.command,valid}));
  }catch(e){next(e);}});
  router.post('/api/worker/jobs/:id/emails/:action', activeJob, body, async (req,res,next) => {
    if (!email) return res.status(503).json({error:'Company email is unavailable'});
    if (!['list','read','code'].includes(req.params.action)) return res.status(404).json({error:'Email action not found'});
    res.setHeader('cache-control','no-store');
    try { res.json(await email.forJob(req.projectThread.board_id,req.projectJob.company_id,req.body?.mailbox_id,req.params.action,req.body || {},()=>{const current=job(req.params.id); return current?.status==='running' && current.worker_id===req.boardlyConnection.id && current.updated_at>Date.now()-120000;})); }
    catch(e) { if(e.status) return res.status(e.status).json({error:e.message}); next(e); }
  });
  router.get('/api/worker/jobs/:id/payments', activeJob, (req, res) => res.json(payments?.summary(req.projectThread.board_id) || null));
  router.post('/api/worker/jobs/:id/payments/:action', activeJob, body, (req, res, next) => {
    if (!payments) return res.status(503).json({ error: 'Project card wallet is unavailable' });
    try {
      const boardId = req.projectThread.board_id;
      if (req.params.action === 'reserve') return res.json(payments.reserve(boardId, req.projectJob.id, req.body || {}));
      if (req.params.action === 'finish') return res.json(payments.finish(boardId, req.body?.purchase_id, req.body || {}, req.projectJob.id));
      return res.status(404).json({ error: 'Checkout action not found' });
    } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
  });
  router.get('/api/worker/jobs/:id/files/:fileId', activeJob, (req, res) => {
    const file = db.prepare('SELECT * FROM project_files WHERE id=? AND board_id=?').get(req.params.fileId, req.projectThread.board_id);
    if (!file?.filename) return res.status(404).json({ error: 'Project file not found' });
    res.download(path.join(uploadsDir, file.filename), file.name);
  });
  db.exec('CREATE TABLE IF NOT EXISTS chat_outputs (job_id TEXT REFERENCES chat_jobs(id) ON DELETE CASCADE,name TEXT NOT NULL,sha256 TEXT NOT NULL,file_id INTEGER NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,PRIMARY KEY(job_id,name,sha256))');
  require('./task-files').backfillTaskOutputs(db);
  const outputUpload = multer({ storage: multer.diskStorage({ destination: uploadsDir, filename: (req, file, cb) => cb(null, 'project-' + crypto.randomUUID()) }), limits: { fileSize: 100 * 1024 * 1024 } });
  router.post('/api/worker/jobs/:id/outputs', activeJob, outputUpload.single('file'), (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an output file' });
    try {
      const name=req.file.originalname.slice(0,250),hash=crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
      const link=id=>require('./task-files').linkGeneratedFile(db,req.projectThread.card_id,id,req.projectThread.board_id);
      const prior=db.prepare('SELECT file_id FROM chat_outputs WHERE job_id=? AND name=? AND sha256=?').get(req.projectJob.id,name,hash);if(prior){link(prior.file_id);fs.rmSync(req.file.path,{force:true});return res.json({id:prior.file_id});}
      const id=db.transaction(()=>{const result=db.prepare('INSERT INTO project_files (uuid,board_id,name,filename,size,mime,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),req.projectThread.board_id,name,req.file.filename,req.file.size,req.file.mimetype,Date.now());db.prepare('INSERT INTO chat_outputs VALUES (?,?,?,?)').run(req.projectJob.id,name,hash,result.lastInsertRowid);link(Number(result.lastInsertRowid));return result.lastInsertRowid;})();res.status(201).json({id});
    } catch (error) { fs.rmSync(req.file.path, { force: true }); next(error); }
  });
  router.post('/api/worker/jobs/:id', body, (req, res) => {
    const j = job(req.params.id);
    if (!j || j.worker_id !== req.boardlyConnection.id) return res.status(404).json({ error: 'Run not found' });
    if (j.status !== 'running') { if(['completed','failed','cancelled'].includes(req.body?.status))db.prepare('UPDATE chat_jobs SET settled_at=? WHERE id=?').run(Date.now(),j.id); return res.json({ status: j.status }); }
    const data = req.body || {};
    if (j.mode==='work' && data.sessionId && /^[a-zA-Z0-9-]{10,80}$/.test(data.sessionId)) db.prepare('UPDATE chat_threads SET codex_session_id=? WHERE id=?').run(data.sessionId, j.thread_id);
    let status = ['completed', 'failed', 'cancelled', 'blocked', 'recovering'].includes(data.status) ? data.status : 'running';
    if(status==='failed'&&j.worker_host==='cloud'){status='blocked';data.blocker=data.blocker||data.error||'The cloud agent runtime could not finish this assignment.';data.next_action=data.next_action||'Review the saved activity and restore the cloud agent connection or AI sign-in, then resume this assignment.';}
    if(status==='blocked'&&(!data.blocker||!data.next_action))return res.status(400).json({error:'A blocker and next action are required'});
    if(status==='recovering'&&j.worker_host!=='cloud')return res.status(400).json({error:'Only cloud workers can recover automatically'});
    if(status!=='running')db.prepare('UPDATE chat_jobs SET settled_at=? WHERE id=?').run(Date.now(),j.id);
    const boardId = thread(j.thread_id).board_id;
    const draft = clean(boardId, typeof data.text === 'string' ? data.text.slice(0, 200000) : j.draft);
    db.transaction(() => {
      const now = Date.now();
      const upsert = db.prepare(`INSERT INTO chat_activity VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id,event_key)
        DO UPDATE SET title=excluded.title,detail=excluded.detail,status=excluded.status,updated_at=excluded.updated_at
        WHERE title!=excluded.title OR detail!=excluded.detail OR status!=excluded.status`);
      for (const entry of Array.isArray(data.activity) ? data.activity.slice(-100) : []) {
        if (!entry || typeof entry.key !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(entry.key) ||
          !['update','command','tool','file','search','plan','status'].includes(entry.kind) ||
          !['running','completed','failed'].includes(entry.status) || typeof entry.title !== 'string') continue;
        const title = clean(boardId, entry.title).slice(0, 200), detail = clean(boardId, typeof entry.detail === 'string' ? entry.detail : '').slice(0, 3000);
        upsert.run(j.id, entry.key, entry.kind, title, detail, entry.status, now, now);
      }
      db.prepare('DELETE FROM chat_activity WHERE job_id=? AND event_key NOT IN (SELECT event_key FROM chat_activity WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200)').run(j.id,j.id);
      db.prepare('UPDATE chat_jobs SET status=?,progress=?,draft=?,error=?,updated_at=? WHERE id=?')
        .run(status, clean(boardId, String(data.progress || j.progress).slice(0, 400)), draft, data.error ? clean(boardId, String(data.error).slice(0, 2000)) : null, Date.now(), j.id);
      if(Number.isSafeInteger(data.continuation_count)&&data.continuation_count>=0)db.prepare('UPDATE chat_jobs SET continuation_count=? WHERE id=?').run(data.continuation_count,j.id);
      if(status==='blocked'){const blocker=clean(boardId,String(data.blocker).slice(0,10000)),nextAction=clean(boardId,String(data.next_action).slice(0,10000));db.prepare('UPDATE chat_jobs SET blocker=?,next_action=? WHERE id=?').run(blocker,nextAction,j.id);blockers.record(j,blocker,nextAction);}
      if(status==='completed')blockers.completed(j);
      if (status === 'completed' && draft) message(j.thread_id, 'assistant', draft);
    })();
    res.json({ status });
  });
  return router;
}
module.exports = { createProjectChat };
