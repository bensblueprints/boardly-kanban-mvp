// Only public connection metadata and a bounded, read-only repository snapshot
// enter the planner context. A paused connector never performs repository reads.
async function companyPlanContext({companyId,github,companyAI,valid}){
 const ai=companyAI.effective(companyId),row=companyId==null?null:github.direct('companies',companyId);
 const context={ai,github:{status:'not_connected'}};
 if(!row)return context;
 const repository=context.github={repository:row.repository,branch:row.branch,status:!row.credential_ready?'needs_token':row.allow_agent?'connected':'paused',files_read:[]};
 if(repository.status!=='connected')return context;
 const check=()=>{if(!valid())throw Error('Company conversation ended.');return true;};
 try{
  check();const listing=await github.operate(row,'list',{},check);check();
  repository.commit=listing.sha;
  const files=listing.files.filter(f=>f.type==='blob'&&typeof f.path==='string');
  repository.paths=files.slice(0,120).map(f=>f.path.slice(0,300));
  repository.paths_truncated=files.length>120;
  const names=['readme.md','readme','package.json','pyproject.toml','cargo.toml'];
  const selected=names.map(n=>files.find(f=>f.path.toLowerCase()===n&&f.size<=64000)).filter(Boolean).slice(0,3);
  let remaining=16000;
  for(const file of selected){
   const result=await github.operate(row,'read',{sha:listing.sha,path:file.path},check);check();
   const raw=Buffer.from(result.content,'base64').toString('utf8'),content=github.redact(raw).slice(0,remaining);
   remaining-=content.length;repository.files_read.push({path:file.path,content,truncated:content.length<raw.length});
   if(!remaining)break;
  }
  repository.status='snapshot_read';
 }catch{
  // Do not send provider/network errors or credentials to the model.
  repository.status='read_failed';repository.error='The saved repository could not be read. Check its connection and branch in Company settings.';
 }
 check();return context;
}
module.exports={companyPlanContext};
