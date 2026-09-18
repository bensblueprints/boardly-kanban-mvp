const express=require('express');
const VERSION=1;
function createOnboarding(db){
 db.exec('CREATE TABLE IF NOT EXISTS account_onboarding(user_id TEXT PRIMARY KEY,version INTEGER NOT NULL,step INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT \'started\',updated_at INTEGER NOT NULL)');
 const read=user=>db.prepare('SELECT version,step,status,updated_at FROM account_onboarding WHERE user_id=?').get(user)||{version:VERSION,step:0,status:'new'};
 const router=express.Router();router.use('/api/onboarding',express.json({limit:'2kb'}));
 router.get('/api/onboarding',(req,res)=>res.json(read(req.cloudUserId)));
 router.put('/api/onboarding',(req,res)=>{
  const {step,status}=req.body||{};
  if(!Number.isInteger(step)||step<0||step>4||!['started','skipped','completed'].includes(status))return res.status(400).json({error:'Choose a valid setup step'});
  db.prepare('INSERT INTO account_onboarding VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,step=excluded.step,status=excluded.status,updated_at=excluded.updated_at').run(req.cloudUserId,VERSION,step,status,Date.now());
  res.json(read(req.cloudUserId));
 });
 return router;
}
module.exports={createOnboarding};
