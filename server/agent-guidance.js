const crypto = require('node:crypto');

// A durable inbox, separate from the run's original assignment and checkpoints.
function createAgentGuidance(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_guidance (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    actor TEXT NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER
  ); CREATE INDEX IF NOT EXISTS guidance_pending ON chat_guidance(job_id,received_at,created_at);`);
  const list = jobId => db.prepare(`SELECT g.id,m.content,g.created_at,g.received_at
    FROM chat_guidance g JOIN chat_messages m ON m.id=g.message_id
    WHERE g.job_id=? ORDER BY g.created_at,g.rowid`).all(jobId);
  return {
    list,
    pending: jobId => list(jobId).filter(x => !x.received_at),
    add: db.transaction((job, id, content, actor) => {
      const prior = db.prepare('SELECT * FROM chat_guidance WHERE id=?').get(id);
      if (prior) {
        const message = db.prepare('SELECT content FROM chat_messages WHERE id=?').get(prior.message_id);
        if (prior.job_id !== job.id || prior.actor !== actor || message.content !== content)
          throw Object.assign(Error('This instruction ID was already used. Send a new instruction.'), {status:409});
        return false;
      }
      if (list(job.id).filter(x=>!x.received_at).length >= 20)
        throw Object.assign(Error('Wait for the agent to receive its queued instructions.'), {status:429});
      const mid=crypto.randomUUID(), now=Date.now();
      db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run(mid,job.thread_id,'user',content,now);
      db.prepare('INSERT INTO chat_guidance VALUES (?,?,?,?,?,NULL)').run(id,job.id,mid,actor,now);
      return true;
    }),
    acknowledge: db.transaction((jobId, ids) => {
      for (const id of Array.isArray(ids) ? ids.slice(0,20) : []) {
        if(typeof id==='string')db.prepare('UPDATE chat_guidance SET received_at=COALESCE(received_at,?) WHERE id=? AND job_id=?').run(Date.now(),id,jobId);
      }
    }),
  };
}

function guidancePrompt(items) {
  return 'The user sent these instructions while this task was running. Continue the same task and retain its original goal unless these instructions change it. First check the current screen, saved progress and any interrupted operation. Never repeat an action whose outcome is uncertain. Human desktop takeover still requires explicit handback.\n'
    + items.map(x=>x.content).join('\n\n');
}
module.exports={createAgentGuidance,guidancePrompt};
