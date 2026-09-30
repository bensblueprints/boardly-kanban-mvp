const {failureKind}=require('./runtime-policy');
// Failover applies to generation transport/allowance errors, never model text,
// safety refusals, tool failures, access failures, or ambiguous usage charges.
async function respondWithFallback({providers,ownerId,authorization:a,jobId,payload,respond}){
 const fallback=async()=>{
  a.selectionValid?.();
  const f=providers.fallbackAuthorize(ownerId,jobId);
  if(!f)throw Object.assign(Error('Local AI fallback is disabled or disconnected.'),{status:409});
  if(a.selectionValid)f.selectionValid=()=>{a.selectionValid();if(!providers.fallbackEnabled(ownerId))throw Object.assign(Error('Local AI fallback was disabled.'),{status:409});};
  return {...await providers.respond(f,jobId,payload),boardly_runtime:'local',boardly_model:f.model};
 };
 if(providers.fallbackForRun(ownerId,jobId))return fallback();
 try{return await respond();}
 catch(error){
  const kind=failureKind(error);
  if(error?.retryable!==false&&['allowance','transient'].includes(kind)&&providers.startFallback(ownerId,jobId,kind==='allowance'?'AI allowance exhausted':'AI provider temporarily unavailable',a.provider==='local'?a.model:null))return fallback();
  throw error;
 }
}
function alternateModel(config,avoid){
 if(!avoid)return config.model;
 return (config.models||[]).filter(m=>typeof m==='string'&&m!==avoid&&/coder|qwen|glm|llama|deepseek/i.test(m)&&!/vision|embedding|embed|\bvl\b|\bvl\d/i.test(m)).sort((a,b)=>Number(/flash/i.test(b))-Number(/flash/i.test(a))||a.localeCompare(b))[0]||null;
}
module.exports={respondWithFallback,alternateModel};
