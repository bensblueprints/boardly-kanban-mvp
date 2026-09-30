const adminTools=new Set(['create_task','update_task','save_file','create_folder','move_file','employee_message']);
function implementationRequested(text){
 // Apply the repository gate to explicit implementation requests, not ordinary
 // planning, review, investigation, or board organization assignments.
 const goal=String(text||'').toLowerCase();
 if(/\b(?:only|just)\s+(?:plan|review|audit|inspect|organize|document)\b|\b(?:plan|design|write)\s+(?:a |the )?(?:specification|spec|architecture|plan)\b/.test(goal))return false;
 return /\b(?:build|implement|fix|modify|change|add|remove|refactor|repair)\b[\s\S]{0,180}\b(?:software|app|application|code|bug|feature|engine|endpoint|api|website|component|function)\b/.test(goal);
}
function sourcePath(path){return typeof path==='string'&&!/(^|\/)(?:docs?|plans?|specs?)(\/|$)|\.(?:md|txt|rst|pdf|docx)$/i.test(path);}
function createWorkEvidence(db,jobId){
 db.exec('CREATE TABLE IF NOT EXISTS chat_work_evidence(job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE,call_id TEXT NOT NULL,name TEXT NOT NULL,summary TEXT NOT NULL,PRIMARY KEY(job_id,call_id));CREATE TABLE IF NOT EXISTS chat_completion_reviews(job_id TEXT PRIMARY KEY REFERENCES chat_jobs(id) ON DELETE CASCADE,attempts INTEGER NOT NULL DEFAULT 0);');
 function record(call,result){
  if(!result||result.error)return;
  let args;try{args=JSON.parse(call.arguments);}catch{return;}
  const summary={admin:adminTools.has(call.name)};
  if(call.name==='github_commit_files'&&result.pushed===true&&/^[a-f0-9]{40}$/.test(result.sha||'')){
   summary.sha=result.sha;summary.paths=(args.files||[]).map(f=>f.path).filter(sourcePath);
  }
  if(call.name==='github_read_file'&&typeof result.text==='string')summary.read=true;
  if(call.name==='execute_ssh')summary.executed=result.code===0;
  db.prepare('INSERT OR IGNORE INTO chat_work_evidence VALUES (?,?,?,?)').run(jobId,call.call_id,call.name,JSON.stringify(summary));
 }
 function restore(input){
  const calls=new Map(input.filter(x=>x.type==='function_call').map(x=>[x.call_id,x]));
  for(const item of input)if(item.type==='function_call_output'&&calls.has(item.call_id)){try{record(calls.get(item.call_id),JSON.parse(item.output));}catch{}}
 }
 function snapshot(){
  const rows=db.prepare('SELECT summary FROM chat_work_evidence WHERE job_id=?').all(jobId).map(r=>JSON.parse(r.summary));
  return {task_updates:rows.filter(r=>r.admin).length,repository_reads:rows.filter(r=>r.read).length,successful_commands:rows.filter(r=>r.executed).length,source_commits:rows.filter(r=>r.sha&&r.paths.length).map(r=>({sha:r.sha,paths:r.paths}))};
 }
 function review(){db.prepare('INSERT INTO chat_completion_reviews VALUES (?,1) ON CONFLICT(job_id) DO UPDATE SET attempts=attempts+1').run(jobId);return db.prepare('SELECT attempts FROM chat_completion_reviews WHERE job_id=?').get(jobId).attempts;}
 return {record,restore,snapshot,review};
}
const instruction='For implementation assignments, creating or rewriting tasks, team messages and planning documents is preparation, not software implementation. Inspect the existing repository, make the authorized source changes and run meaningful checks. Record commit SHAs, changed files and actual verification results; distinguish committed, tested and deployed. Reuse existing tasks rather than expanding the backlog instead of doing the assignment. Never invent evidence, make a token edit to satisfy a check, bypass safety restrictions, or repeat an external mutation whose result is unknown. For planning-only assignments, deliver the requested plan without claiming implementation.';
module.exports={implementationRequested,createWorkEvidence,instruction};
