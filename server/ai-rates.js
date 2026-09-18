// Standard text API prices, USD per million tokens. Review against the official
// pricing page before changing this version; historical ledger rows retain it.
const VERSION='openai-standard-2026-09-07';
const RATES={
 'gpt-6-astra':{input:10,cached:1,write:12.5,output:50,long:{input:20,cached:2,write:25,output:75}},
 'gpt-5.6-sol':{input:4,cached:.4,write:5,output:20,long:{input:8,cached:.8,write:10,output:30}},
 'gpt-5.6-terra':{input:2,cached:.2,write:2.5,output:12,long:{input:4,cached:.4,write:5,output:18}},
};
function cost(response){
 const model=Object.keys(RATES).find(m=>response.model===m||response.model.startsWith(m+'-2026-'));
 const u=response.usage,d=u?.input_tokens_details||{};
 if(!model||!u||!['default',undefined,null].includes(response.service_tier))throw Error('Usage needs pricing review');
 const counts=[u.input_tokens,u.output_tokens,d.cached_tokens??0,d.cache_write_tokens??0];
 if(counts.some(n=>!Number.isSafeInteger(n)||n<0)||counts[2]+counts[3]>counts[0])throw Error('Usage needs pricing review');
 const [input,output,cached,write]=counts,r=input>272000?RATES[model].long:RATES[model];
 const nano=Math.round(((input-cached-write)*r.input+cached*r.cached+write*r.write+output*r.output)*1000);
 if(!Number.isSafeInteger(nano))throw Error('Usage needs pricing review');
 return{model,version:VERSION,nano,input,output,cached,write};
}
module.exports={VERSION,RATES,cost};
