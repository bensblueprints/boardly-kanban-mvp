const crypto=require('node:crypto');
// A probe never receives workspace content or tools and never enters a Work queue.
async function probe({provider,model,valid,respond,id='ai-ping-'+crypto.randomUUID()}){
 const start=performance.now();
 try{
  valid();
  const result=await respond(id,{model,service_tier:'default',store:false,input:[{role:'user',content:'Connection test. Reply with only OK.'}],tools:[],max_output_tokens:512});
  valid();
  const reply=(result.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n').trim().slice(0,500);
  if(!reply)throw Object.assign(Error('The model responded without a text reply. Try a chat-capable model.'),{status:502});
  return {ok:true,provider,model,reply,latency_ms:Math.round(performance.now()-start),tested_at:Date.now()};
 }catch(e){
  return {ok:false,provider,model,error:e.status?e.message:'The model could not be reached. Check the connection and try again.',latency_ms:Math.round(performance.now()-start),tested_at:Date.now()};
 }
}
module.exports={probe};
