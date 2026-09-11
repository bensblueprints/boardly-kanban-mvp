const express=require('express'),crypto=require('node:crypto');
const fail=message=>Object.assign(Error(message),{status:503});
// The owner worker generates text/structured suggestions only. It never runs a
// member's shell or receives project secrets; hosted-ai checks every tool call.
function createSubscriptionAI({db,ownerId,canEdit,connections}) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_requests (
    id TEXT PRIMARY KEY,job_id TEXT NOT NULL,payer_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    model TEXT NOT NULL,status TEXT NOT NULL,payload TEXT,result TEXT,usage_json TEXT,
    worker_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS subscription_workers(id TEXT PRIMARY KEY,last_seen INTEGER NOT NULL);`);
  db.prepare("UPDATE subscription_requests SET status='interrupted',payload=NULL,result=NULL WHERE status IN ('queued','running')").run();
  let closed=false;
  const live=row=>{const j=db.prepare('SELECT j.status,j.requested_by,t.board_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id WHERE j.id=?').get(row.job_id);return j?.status==='running'&&j.requested_by===row.actor_id&&canEdit(row.actor_id,j.board_id);};
  const online=()=>connections.list(ownerId).some(c=>c.scope==='worker'&&!c.revoked_at&&c.expires_at>Date.now()&&db.prepare('SELECT 1 FROM subscription_workers WHERE id=? AND last_seen>?').get(c.id,Date.now()-45000));
  async function respond(actor,jobId,payload){
    if(!online())throw fail('The company owner’s subscription worker is offline. Ask the owner to reconnect it.');
    const id=crypto.randomUUID(),now=Date.now(),row={job_id:jobId,actor_id:actor};
    if(!live(row))throw fail('Run stopped or project access was removed');
    if(Buffer.byteLength(JSON.stringify(payload))>4000000)throw fail('This conversation is too large. Start a new conversation.');
    db.prepare("INSERT INTO subscription_requests(id,job_id,payer_id,actor_id,model,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?,?)")
      .run(id,jobId,ownerId,actor,payload.model,JSON.stringify(payload),now,now);
    try{
      while(!closed){
        const saved=db.prepare('SELECT * FROM subscription_requests WHERE id=?').get(id);
        if(!live(row))throw fail('Run stopped or project access was removed');
        if(saved.status==='completed')return JSON.parse(saved.result);
        if(!['queued','running'].includes(saved.status))throw fail('The owner’s subscription response was interrupted. Reconnect the worker and resume the task.');
        if(Date.now()-saved.updated_at>(saved.status==='queued'?900000:180000))throw fail('The owner’s subscription worker stopped responding. Check its connection and resume the task.');
        await new Promise(r=>setTimeout(r,200));
      }
      throw fail('The AI server is restarting');
    }finally{if(!closed)db.prepare("UPDATE subscription_requests SET payload=NULL,result=NULL,status=CASE WHEN status IN ('queued','running') THEN 'interrupted' ELSE status END WHERE id=?").run(id);}
  }
  const router=express.Router();
  router.use('/api/worker',(req,res,next)=>{if(req.boardlyConnection)db.prepare('UPDATE subscription_workers SET last_seen=? WHERE id=?').run(Date.now(),req.boardlyConnection.id);next();});
  router.post('/api/worker/claim',express.json({limit:'4kb'}),(req,res,next)=>{
    if(req.body?.subscription_bridge!==true)return next();
    db.prepare('INSERT INTO subscription_workers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen').run(req.boardlyConnection.id,Date.now());
    const result=db.transaction(()=>{
      const total=db.prepare("SELECT (SELECT COUNT(*) FROM subscription_requests WHERE status='running')+(SELECT COUNT(*) FROM chat_jobs WHERE runtime='codex' AND status='running')+(SELECT COUNT(*) FROM discussion_jobs WHERE runtime='codex' AND status='running') n").get().n;
      if(total>=4)return{busy:true};
      for(const row of db.prepare("SELECT * FROM subscription_requests WHERE status='queued' ORDER BY created_at").all()){
        if(!live(row)){db.prepare("UPDATE subscription_requests SET status='cancelled',payload=NULL WHERE id=?").run(row.id);continue;}
        db.prepare("UPDATE subscription_requests SET status='running',worker_id=?,updated_at=? WHERE id=?").run(req.boardlyConnection.id,Date.now(),row.id);
        return{id:row.id,kind:'subscription',payload:JSON.parse(row.payload)};
      }
    })();
    if(result)return res.json({job:result.busy?null:result});next();
  });
  router.post('/api/worker/subscriptions/:id',express.json({limit:'1mb'}),(req,res)=>{
    const row=db.prepare('SELECT * FROM subscription_requests WHERE id=? AND worker_id=?').get(req.params.id,req.boardlyConnection.id);
    if(!row)return res.status(404).json({error:'Response not found'});
    if(row.status!=='running')return res.json({status:row.status});
    if(!live(row)){db.prepare("UPDATE subscription_requests SET status='cancelled',payload=NULL WHERE id=?").run(row.id);return res.json({status:'cancelled'});}
    const status=['completed','failed','cancelled'].includes(req.body?.status)?req.body.status:'running';
    if(status==='completed'){
      const r=req.body.result;
      if(!r||!Array.isArray(r.output)||r.output.length>30)return res.status(400).json({error:'Invalid structured response'});
      db.prepare('UPDATE subscription_requests SET result=?,usage_json=? WHERE id=?').run(JSON.stringify(r),JSON.stringify(r.usage||{}),row.id);
    }
    db.prepare('UPDATE subscription_requests SET status=?,updated_at=? WHERE id=?').run(status,Date.now(),row.id);
    res.json({status});
  });
  router.post('/api/worker/reconnect',express.json({limit:'4kb'}),(req,res,next)=>{
    db.prepare("UPDATE subscription_requests SET status='interrupted',payload=NULL WHERE worker_id=? AND status='running'").run(req.boardlyConnection.id);next();
  });
  return{router,respond,online,close(){closed=true;}};
}
module.exports={createSubscriptionAI};
