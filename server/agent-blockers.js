function createAgentBlockers(db){
 function list(projectId,name){let row=db.prepare('SELECT id FROM lists WHERE board_id=? AND name=? AND archived=0').get(projectId,name);if(!row){const p=db.prepare('SELECT COALESCE(MAX(position)+1,0) p FROM lists WHERE board_id=?').get(projectId).p;row={id:db.prepare('INSERT INTO lists(board_id,name,position) VALUES (?,?,?)').run(projectId,name,p).lastInsertRowid};}return row.id;}
 function record(job,blocker,nextAction){
  const t=db.prepare('SELECT * FROM chat_threads WHERE id=?').get(job.thread_id);
  let card=db.prepare('SELECT c.* FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=? AND c.archived=0').get(job.blocker_card_id||t.card_id,t.board_id);
  const listId=list(t.board_id,'Blocked');
  if(!card)card={id:db.prepare('INSERT INTO cards(list_id,title,description) VALUES (?,?,?)').run(listId,('Agent needs help: '+t.title).slice(0,250),`This task tracks a blocker in the saved project conversation. Run: ${job.id}`).lastInsertRowid};
  db.prepare('UPDATE cards SET list_id=? WHERE id=?').run(listId,card.id);
  db.prepare('INSERT INTO comments(card_id,author,body) VALUES (?,?,?)').run(card.id,'boredly agent',`Blocker: ${blocker}\n\nNext action: ${nextAction}\n\nRun: ${job.id}`);
  db.prepare('INSERT INTO activity(board_id,card_id,action,detail) VALUES (?,?,?,?)').run(t.board_id,card.id,'agent_blocked','Agent paused: '+blocker.slice(0,300));
  db.prepare('UPDATE chat_jobs SET blocker_card_id=? WHERE id=?').run(card.id,job.id);return card.id;
 }
 function resumed(job){if(!job.blocker_card_id)return;const t=db.prepare('SELECT board_id FROM chat_threads WHERE id=?').get(job.thread_id);const card=db.prepare('SELECT c.id,l.name FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=? AND c.archived=0').get(job.blocker_card_id,t.board_id);if(card?.name==='Blocked'){db.prepare('UPDATE cards SET list_id=? WHERE id=?').run(list(t.board_id,'To Do'),card.id);db.prepare('INSERT INTO comments(card_id,author,body) VALUES (?,?,?)').run(card.id,'boredly agent','The user requested resume. This assignment is queued; re-check its dependency when work starts.');}}
 function completed(job){if(!job.blocker_card_id)return;const t=db.prepare('SELECT board_id FROM chat_threads WHERE id=?').get(job.thread_id);const card=db.prepare('SELECT c.id,l.name FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=? AND c.archived=0').get(job.blocker_card_id,t.board_id);if(card?.name==='In Progress'){db.prepare('UPDATE cards SET list_id=? WHERE id=?').run(list(t.board_id,'Done Awaiting Revisions'),card.id);db.prepare('INSERT INTO comments(card_id,author,body) VALUES (?,?,?)').run(card.id,'boredly agent','The resumed assignment completed and reported verification.');}}
 function started(job){if(!job.blocker_card_id)return;const t=db.prepare('SELECT board_id FROM chat_threads WHERE id=?').get(job.thread_id);const c=db.prepare("SELECT c.id FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=? AND l.board_id=? AND l.name='To Do' AND c.archived=0").get(job.blocker_card_id,t.board_id);if(c)db.prepare('UPDATE cards SET list_id=? WHERE id=?').run(list(t.board_id,'In Progress'),c.id);}
 return{record,resumed,completed,started};
}
module.exports={createAgentBlockers};
