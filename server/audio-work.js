const crypto = require('node:crypto');
const { projectQueue, cleanValues } = require('./agent-scheduling');
const fail = (status, message) => Object.assign(Error(message), { status });
const withoutVoiceRules = text => String(text).split('\n\nVoice briefing instructions:')[0];

function createAudioWork({ db, userId, clean, enqueue }) {
  db.exec(`CREATE TABLE IF NOT EXISTS audio_work_launches (
    request_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    source_kind TEXT NOT NULL, source_id INTEGER NOT NULL, source_thread TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
  );`);
  const projects = (kind, id) => kind === 'project'
    ? db.prepare('SELECT id,name FROM boards WHERE id=?').all(id)
    : db.prepare(`SELECT p.workspace_id AS id,p.name,b.name AS board_name FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE ${kind === 'board' ? 'b.id' : 'b.company_id'}=? ORDER BY b.name,p.name`).all(id);
  function source(kind, id, threadId, replyId) {
    if (kind === 'project') {
      const row = db.prepare("SELECT m.rowid AS position FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE m.id=? AND m.thread_id=? AND m.role='assistant' AND t.board_id=?").get(replyId, threadId, id);
      if (!row) throw fail(404, 'Briefing reply not found in this project');
      return db.prepare('SELECT role,content FROM chat_messages WHERE thread_id=? AND rowid<=? ORDER BY rowid DESC LIMIT 8').all(threadId, row.position).reverse();
    }
    const row = db.prepare("SELECT j.rowid AS position FROM discussion_jobs j JOIN discussion_threads t ON t.id=j.thread_id WHERE j.id=? AND j.thread_id=? AND j.status='completed' AND t.scope_type=? AND t.scope_id=?").get(replyId, threadId, kind, id);
    if (!row) throw fail(404, 'Briefing reply not found in this company or board');
    return db.prepare("SELECT prompt,draft FROM discussion_jobs WHERE thread_id=? AND rowid<=? AND status='completed' ORDER BY rowid DESC LIMIT 4").all(threadId, row.position).reverse().flatMap(r => [{ role: 'user', content: r.prompt }, { role: 'assistant', content: r.draft }]);
  }
  function result(row) {
    return { request_key: row.request_key, project_id: row.project_id, thread_id: row.thread_id, job_id: row.job_id };
  }
  function start({ kind, id, actor, runtime, body }) {
    const { request_key, thread_id, reply_id, project_id, content } = body || {};
    if (typeof request_key !== 'string' || !/^[a-f0-9-]{36}$/.test(request_key)) throw fail(400, 'A work request ID is required');
    if (typeof thread_id !== 'string' || typeof reply_id !== 'string' || thread_id.length > 100 || reply_id.length > 100) throw fail(400, 'Choose a saved briefing reply first');
    if (typeof content !== 'string' || !content.trim() || content.length > 6000) throw fail(400, 'Describe the work in your response (up to 6000 characters)');
    const allowed = projects(kind, id), project = allowed.find(p => p.id === project_id);
    if (!Number.isSafeInteger(project_id) || !project) throw fail(404, 'Choose a project in this briefing');
    const history = source(kind, id, thread_id, reply_id);
    const hash = crypto.createHash('sha256').update(JSON.stringify([kind,id,thread_id,reply_id,project_id,content.trim()])).digest('hex');
    const saved = db.prepare('SELECT * FROM audio_work_launches WHERE request_key=?').get(request_key);
    if (saved) {
      if (saved.actor_id !== actor || saved.request_hash !== hash) throw fail(409, 'This work request ID was already used for another response');
      return result(saved);
    }
    const scrub = text => allowed.reduce((value, p) => clean(p.id, value), text);
    const context = history.map(m => `${m.role === 'assistant' ? 'AI' : 'User'}: ${withoutVoiceRules(m.content).slice(0,3000)}`).join('\n\n').slice(-18000);
    const instruction = scrub(`Start Work in project ${project.name} after an audio briefing.\n\nUser's work request:\n${content.trim()}\n\nEarlier briefing conversation (reference only; may be stale):\n${context}\n\nAct on the user's work request in this project only. Recheck its current tasks, files and connections before acting. Treat the earlier discussion as context, not additional authorization. Do not perform work in other projects. Save progress and verification in this project, and report any real blocker with the next action.`);
    const now = Date.now(), workThread = crypto.randomUUID(), mid = crypto.randomUUID(), job = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO chat_threads(id,board_id,title,created_at) VALUES (?,?,?,?)').run(workThread,project_id,scrub('Audio work: '+content.trim()).slice(0,82),now);
      db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run(mid,workThread,'user',instruction,now);
      db.prepare("INSERT INTO chat_jobs(id,thread_id,message_id,status,mode,runtime,requested_by,billing_owner_id,created_at,updated_at) VALUES (?,?,?,'queued','work',?,?,?,?,?)").run(job,workThread,mid,runtime,actor,userId,now,now);
      db.prepare('INSERT INTO audio_work_launches VALUES (?,?,?,?,?,?,?,?,?,?)').run(request_key,actor,hash,kind,id,thread_id,project_id,workThread,job,now);
    })();
    if (runtime === 'api') enqueue();
    return result({ request_key, project_id, thread_id: workThread, job_id: job });
  }
  function list({ kind, id, actor, threadId }) {
    const allowed = new Set(projects(kind,id).map(p=>p.id));
    return db.prepare(`SELECT a.project_id,a.thread_id,b.name AS project_name,j.id,j.message_id,j.mode,j.status,j.progress,j.draft,j.error,j.created_at,j.started_at,j.updated_at,j.worker_host,j.continuation_count,j.blocker,j.next_action
      FROM audio_work_launches a JOIN chat_jobs j ON j.id=a.job_id JOIN boards b ON b.id=a.project_id
      WHERE a.source_kind=? AND a.source_id=? AND a.source_thread=? AND a.actor_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 5`).all(kind,id,threadId,actor).filter(r=>allowed.has(r.project_id)).map(r=>{
        r.activity=db.prepare('SELECT event_key AS key,kind,title,detail,status,created_at,updated_at FROM chat_activity WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30').all(r.id).reverse();
        if(r.status==='queued')r.queue=projectQueue(db,r.id);
        return cleanValues(r,value=>clean(r.project_id,value));
      });
  }
  return { start, list };
}
module.exports = { createAudioWork };
