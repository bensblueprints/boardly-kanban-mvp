const MAX_AGENTS = 4;
// Redact text fields without treating timestamps/IDs or JSON syntax as secret text.
function cleanValues(value, clean) {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(item => cleanValues(item, clean));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,cleanValues(item,clean)]));
  return value;
}
// Keep writers to a shared project in order; other projects and discussions can run together.
function nextProjectJob(db, runtime) {
  return db.prepare(`SELECT j.*,t.board_id,t.card_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id
    WHERE j.status='queued' AND j.runtime=? AND NOT EXISTS (
      SELECT 1 FROM chat_jobs r JOIN chat_threads rt ON rt.id=r.thread_id
      WHERE (r.status IN ('running','recovering') OR (r.status='cancelled' AND r.worker_id IS NOT NULL AND r.settled_at IS NULL AND r.updated_at>strftime('%s','now')*1000-604800000)) AND (r.thread_id=j.thread_id OR (rt.board_id=t.board_id AND r.mode='work' AND j.mode='work')))
    ORDER BY j.created_at,j.rowid LIMIT 1`).get(runtime);
}
function snapshot(db, ids) {
  return ids.map(id => ({
    project: db.prepare('SELECT id,name,description FROM boards WHERE id=?').get(id),
    scope: require('./hierarchy').createHierarchy(db).scope(id),
    lists: db.prepare('SELECT id,name FROM lists WHERE board_id=? AND archived=0').all(id),
    tasks: db.prepare(`SELECT c.id,c.title,c.description,l.name AS status FROM cards c JOIN lists l ON l.id=c.list_id
      WHERE l.board_id=? AND c.archived=0 AND l.archived=0 ORDER BY c.position LIMIT 200`).all(id).map(c => ({...c,
      checklists: db.prepare('SELECT i.text,i.done FROM checklist_items i JOIN checklists x ON x.id=i.checklist_id WHERE x.card_id=? ORDER BY x.position,i.position LIMIT 100').all(c.id),
      comments: db.prepare('SELECT author,body,created_at FROM comments WHERE card_id=? ORDER BY id DESC LIMIT 5').all(c.id)})),
    files: db.prepare('SELECT id,name,url FROM project_files WHERE board_id=? LIMIT 100').all(id),
    links: db.prepare('SELECT title,url,description FROM project_links WHERE board_id=? LIMIT 100').all(id)
  }));
}
const modeInstruction = mode => mode === 'plan'
  ? 'PLAN MODE. Discuss and clarify the request, then propose a concrete plan. Ask concise questions if needed. Do not execute the plan, change tasks or files, send messages, or start agents. The user must explicitly switch to Work to authorize action.'
  : 'ASK MODE. Answer questions, explore ideas and ask for clarification. Do not change anything, execute commands, send messages or start agents. The user must explicitly switch to Work to authorize action.';
module.exports = { cleanValues, MAX_AGENTS, nextProjectJob, snapshot, modeInstruction };
