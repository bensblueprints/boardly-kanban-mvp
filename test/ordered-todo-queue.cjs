const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'boardly-ordered-'));
const db=require('../server/db').openDb(root);
try{
 const chat=require('../server/project-chat').createProjectChat({db,userId:'owner',connections:{},uploadsDir:root});
 let employees=chat.employees;
 const board=name=>Number(db.prepare('INSERT INTO boards(name) VALUES(?)').run(name).lastInsertRowid);
 const list=(id,position,name='To Do')=>Number(db.prepare('INSERT INTO lists(board_id,name,position) VALUES(?,?,?)').run(id,name,position).lastInsertRowid);
 const card=(id,title,position)=>Number(db.prepare('INSERT INTO cards(list_id,title,position) VALUES(?,?,?)').run(id,title,position).lastInsertRowid);
 const a=board('First'),b=board('Second'),foreign=board('Not owner authorized');
 const late=list(a,5),early=list(a,0),second=list(b,0),untrusted=list(foreign,0);
 const z=card(late,'Later list',0),y=card(early,'Later card',2),x=card(early,'First card',1),n=card(second,'Second board',0);
 const archived=card(early,'Archived',0);db.prepare('UPDATE cards SET archived=1 WHERE id=?').run(archived);
 card(untrusted,'Member cannot authorize continuous processing',0);
 employees.configure(b,true,'Bounded authorized queue','owner','api',true);
 employees.configure(a,true,'Bounded authorized queue','owner','api',true);
 employees.configure(foreign,true,'Untrusted','member','api',true);
 const active=()=>db.prepare("SELECT j.*,t.card_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id WHERE j.status IN ('queued','running','recovering')").all();
 const blockers=require('../server/agent-blockers').createAgentBlockers(db);
 function finish(blocked=false){const j=active()[0];db.prepare("UPDATE chat_jobs SET status='running' WHERE id=?").run(j.id);blockers.started(j);if(blocked)blockers.record(j,'Missing fixture input','Supply fixture input');else blockers.completed(j);db.prepare('UPDATE chat_jobs SET status=? WHERE id=?').run(blocked?'blocked':'completed',j.id);}
 employees.tick();assert.deepEqual(active().map(j=>j.card_id),[x]);
 assert.equal(db.prepare('SELECT list_id FROM cards WHERE id=?').get(x).list_id,late,'Claim remains To Do until the worker starts');
 employees.tick();assert.equal(active().length,1,'No duplicate or parallel root claims');
 assert.equal(db.prepare('SELECT list_id FROM cards WHERE id=?').get(y).list_id,early,'Waiting cards remain in place');
 // Configuration persists and reconstructing the coordinator cannot duplicate work.
 employees=require('../server/project-employees').createProjectEmployees({db,ownerId:'owner',clean:(_,s)=>s});
 employees.tick();assert.equal(active().length,1);
 finish();employees.tick();assert.deepEqual(active().map(j=>j.card_id),[y]);
 finish(true);employees.tick();assert.deepEqual(active().map(j=>j.card_id),[z],'A real blocker allows the next independent card');
 finish();employees.tick();assert.deepEqual(active().map(j=>j.card_id),[n]);
 finish();employees.tick();assert.equal(active().length,0,'No member-authorized or archived work');
 // Moving completed work back to To Do explicitly queues it again; historical
 // assignments must not make it permanently invisible.
 db.prepare('UPDATE cards SET list_id=? WHERE id=?').run(early,x);
 employees.configure(a,false,'Paused');employees.tick();assert.equal(active().length,0);
 assert.equal(employees.context(a).team.ordered,1,'Ordinary pause controls preserve ordered mode');
 employees.configure(a,true,'Resume');employees.tick();assert.deepEqual(active().map(j=>j.card_id),[x]);
 assert.throws(()=>employees.configure(a,true,'Invalid','owner','api','yes'),/boolean/);
 console.log('PASS: stable board/list/card ordering, one active root, lifecycle, blocked advance, archive/owner isolation, restart, requeued work and pause controls');
}finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
