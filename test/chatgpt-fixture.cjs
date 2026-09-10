const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createChatGPTService}=require('../scripts/chatgpt-service.cjs');
async function connectorFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'Boardly-chatgpt-test-')),command=path.join(root,'codex.cjs'),token=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(command,`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),readline=require('readline');
const dir=process.env.CODEX_HOME,authFile=path.join(dir,'auth.json');
assert.ok(dir.startsWith(${JSON.stringify(root)}));assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.BOARDLY_CHATGPT_TOKEN_FILE,undefined);
const auth=()=>{try{return JSON.parse(fs.readFileSync(authFile,'utf8'));}catch{return null;}};
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(process.argv.includes('app-server')){
 let pending=null;
 const timer=setInterval(()=>{const approval=path.join(dir,'approve.json');if(pending&&fs.existsSync(approval)){const a=JSON.parse(fs.readFileSync(approval,'utf8'));fs.rmSync(approval);fs.writeFileSync(authFile,JSON.stringify({...a,privateToken:'NEVER-RETURN-THIS-CREDENTIAL'}),{mode:0o600});emit({method:'account/login/completed',params:{loginId:pending,success:true,error:null}});pending=null;}},20);
 process.stdin.on('end',()=>{clearInterval(timer);process.exit(0);});
 readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;
 let result={};
 if(m.method==='account/read')result={account:auth()?{type:'chatgpt',email:auth().email,planType:'plus'}:null,requiresOpenaiAuth:true};
 if(m.method==='account/login/start'){assert.equal(m.params.type,'chatgptDeviceCode');pending='login-'+path.basename(path.dirname(path.dirname(dir)));result={type:'chatgptDeviceCode',loginId:pending,verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-1234'};}
 if(m.method==='account/login/cancel'){pending=null;result={};}
 if(m.method==='account/logout'){fs.rmSync(authFile,{force:true});pending=null;}
 emit({id:m.id,result});
 });
}else{
 assert.ok(process.argv.includes('--ignore-user-config'));assert.ok(process.argv.includes('--ignore-rules'));assert.ok(process.argv.includes('--ephemeral'));assert.ok(process.argv.includes('mcp_servers={}'));
 for(const flag of ['shell_tool','unified_exec','apps','plugins','hooks','browser_use','code_mode','multi_agent','memory_tool'])assert.ok(process.argv.includes('features.'+flag+'=false'));
 const a=auth();assert.ok(a);let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const payload=JSON.parse(input.slice(input.indexOf('\\n')+1));
 assert.ok(!input.includes('NEVER-RETURN-THIS-CREDENTIAL'));
 const outputs=payload.input.filter(x=>x.type==='function_call_output');let value={text:'ChatGPT reply from '+a.email,calls:[]};
 if(payload.tools.length&&input.includes('Create the authorized task')){
  if(!outputs.length)value={text:'Reading the project.',calls:[{name:'get_project',arguments:'{}'}]};
  else if(outputs.length===1){const project=JSON.parse(outputs[0].output);value={text:'Creating the task.',calls:[{name:'create_task',arguments:JSON.stringify({list_id:project.lists[0].id,title:'ChatGPT customer task',description:'Authorized project work'})}]};}
 }
 if(input.includes('unavailable-tool'))value={text:'',calls:[{name:'shell',arguments:'{}'}]};
 if(input.includes('simulate-rate-limit')){emit({type:'error',message:'usage_limit_reached'});process.exit(1);}
 const delay=input.includes('slow-response')?1200:20;
 setTimeout(()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify(value));emit({type:'turn.completed',usage:{input_tokens:30,output_tokens:10}});},delay);
 });
}
`,{mode:0o700});
 const service=createChatGPTService({root:path.join(root,'profiles'),token,command});service.server.listen(0,'127.0.0.1');await new Promise(r=>service.server.once('listening',r));const url='http://127.0.0.1:'+service.server.address().port;
 const hash=user=>crypto.createHash('sha256').update(user).digest('hex');
 const request=(user,action,body,headers={})=>fetch(`${url}/accounts/${hash(user)}/${action}`,{method:action==='status'?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 async function approve(user,email){const dir=path.join(root,'profiles',hash(user),'home','.codex');fs.writeFileSync(path.join(dir,'approve.json'),JSON.stringify({email}));for(let i=0;i<100;i++){const v=await(await request(user,'status')).json();if(v.connected)return v;await new Promise(r=>setTimeout(r,20));}throw Error('Mock login did not complete');}
 return{root,service,url,token,request,approve,async close(){await service.close();await new Promise(r=>setTimeout(r,2100));fs.rmSync(root,{recursive:true,force:true});}};
}
module.exports={connectorFixture};
