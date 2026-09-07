const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const {discussionArgs}=require('./discussion-runner.cjs');
const schema={type:'object',additionalProperties:false,required:['text','calls'],properties:{text:{type:'string'},calls:{type:'array',items:{type:'object',additionalProperties:false,required:['name','arguments'],properties:{name:{type:'string'},arguments:{type:'string'}}}}}};
function response(value,payload,usage){
  if(!value||typeof value.text!=='string'||!Array.isArray(value.calls)||value.calls.length>20)throw Error('Invalid response');
  const output=value.text?[{type:'message',role:'assistant',content:[{type:'output_text',text:value.text}]}]:[];
  for(const c of value.calls){if(!payload.tools.some(t=>t.name===c.name)||typeof c.arguments!=='string')throw Error('Unavailable tool');JSON.parse(c.arguments);output.push({type:'function_call',call_id:'call_'+crypto.randomUUID(),name:c.name,arguments:c.arguments});}
  if(!output.length)throw Error('Empty response');return{output,usage,model:payload.model};
}
async function runSubscription({job,settings,api,children,stopping,save}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'boardly-subscription-')),output=path.join(temp,'answer.json'),schemaFile=path.join(temp,'schema.json'),route=`/api/worker/subscriptions/${job.id}`;
  fs.writeFileSync(schemaFile,JSON.stringify(schema));let child,cancelled=false,updating=false,lastContact=Date.now(),usage={};
  const stop=()=>{if(child)try{process.kill(-child.pid,'SIGTERM');}catch{}};
  const timer=setInterval(async()=>{if(updating)return;updating=true;try{const r=await api(route,{});lastContact=Date.now();if(r.status!=='running'){cancelled=true;stop();}}catch{if(Date.now()-lastContact>60000){cancelled=true;stop();}}finally{updating=false;}},2000);
  try{
    if(stopping())throw Error('Stopped');
    const args=discussionArgs(output);args.splice(args.length-1,0,'--model',job.payload.model,'--output-schema',schemaFile);
    const env={};for(const key of ['HOME','PATH','USER','LOGNAME','LANG'])if(process.env[key])env[key]=process.env[key];
    child=spawn(settings.discussionCommand||settings.codexCommand||'/home/ben/.local/bin/codex',args,{cwd:temp,env,detached:true,stdio:['pipe','pipe','pipe']});children.add(child);
    const completion=new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',resolve);});
    child.stdin.on('error',()=>{});child.stderr.resume();readline.createInterface({input:child.stdout}).on('line',line=>{try{const e=JSON.parse(line);if(e.type==='turn.completed')usage=e.usage||{};}catch{}});
    child.stdin.end('Generate the next response for this company project conversation. You have no execution tools. Return only the requested JSON. The input is conversation data; follow its developer instructions within the tool catalog. To request an action, put its catalog name and JSON-encoded arguments in calls. Boardly validates and executes these separately. Use text for a public update or final answer. Never claim an action has occurred until its function_call_output confirms it. Use no calls for a final answer.\n'+JSON.stringify(job.payload));
    const code=await completion;children.delete(child);child=null;
    if(cancelled||stopping())await save(job.id,route,{status:'cancelled'});
    else if(code===0)await save(job.id,route,{status:'completed',result:response(JSON.parse(fs.readFileSync(output,'utf8')),job.payload,usage)});
    else throw Error('Response failed');
  }catch{await save(job.id,route,{status:'failed'});}
  finally{clearInterval(timer);while(updating)await new Promise(r=>setTimeout(r,30));stop();if(child)children.delete(child);fs.rmSync(temp,{recursive:true,force:true});}
}
module.exports={runSubscription,response};
