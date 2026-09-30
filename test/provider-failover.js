const assert=require('node:assert/strict');
const {respondWithFallback,alternateModel}=require('../server/provider-failover');
(async()=>{
 assert.equal(alternateModel({model:'coder',models:['qwen3-vl:32b','glm4.7-flash','coder']},'coder'),'glm4.7-flash');assert.equal(alternateModel({model:'coder',models:['coder']},'coder'),null);
 assert.equal(alternateModel({model:'coder',models:['qwen2.5vl:32b']},'coder'),null);
 let switches=0,generated=0,active=false,allowed=true;
 const providers={fallbackEnabled:()=>allowed,fallbackForRun:()=>active,fallbackAuthorize:()=>allowed?{model:'glm4.7-flash'}:null,startFallback:(_owner,_id,_reason,avoid)=>{assert.equal(avoid,'coder');switches++;return active=true;},respond:async(a)=>{a.selectionValid?.();generated++;return {text:'Recovered'};}};
 const args={providers,ownerId:'owner',jobId:'run',authorization:{provider:'local',model:'coder',selectionValid:()=>{}},payload:{}};
 const result=await respondWithFallback({...args,respond:async()=>{throw Object.assign(Error('Timeout'),{status:504});}});assert.equal(result.boardly_model,'glm4.7-flash');assert.equal(switches,1);
 await respondWithFallback({...args,respond:async()=>{throw Error('Original provider must not run');}});assert.equal(generated,2);assert.equal(switches,1);
 active=false;
 for(const error of [Object.assign(Error('Refused'),{code:'safety_refusal'}),Object.assign(Error('Filtered'),{code:'content_filter',status:503}),Object.assign(Error('Access denied'),{status:403}),Object.assign(Error('Usage needs review'),{status:503,retryable:false})])await assert.rejects(respondWithFallback({...args,respond:async()=>{throw error;}}),e=>e===error);
 assert.equal(switches,1);
 const refusal=await respondWithFallback({...args,respond:async()=>({text:'I cannot help with that request.'})});assert.equal(refusal.text,'I cannot help with that request.');assert.equal(switches,1);
 active=true;allowed=false;await assert.rejects(respondWithFallback({...args,respond:async()=>({})}),/disabled/);
 console.log('PASS: technical failover persists per run, chooses a different local model and respects refusals, access changes and uncertain usage');
})().catch(e=>{console.error(e);process.exitCode=1;});
