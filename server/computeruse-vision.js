const crypto=require('node:crypto'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const fail=(status,message)=>Object.assign(Error(message),{status});
const PORT=18765,MODEL='Qwen3-VL-8B-Instruct-Q4_K_M';
const root=path.join(__dirname,'../scripts/qwen-vision');

// HTTP is carried only inside the account's authenticated, pinned SSH tunnel.
function requestOverSocket(sock,route,body,valid){
 return new Promise((resolve,reject)=>{
  let done=false;const payload=body===undefined?null:JSON.stringify(body);
  const finish=(error,result)=>{if(done)return;done=true;clearInterval(check);clearTimeout(timer);request.destroy();error?reject(error):resolve(result);};
  const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>sock;
  const request=http.request({hostname:'127.0.0.1',port:PORT,path:route,method:payload?'POST':'GET',agent,headers:{'Content-Type':'application/json',...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})}},response=>{
   let raw='';response.on('error',()=>finish(fail(503,'Private GPU connection interrupted. No GPT fallback was used.')));
   response.on('data',part=>{raw+=part;if(Buffer.byteLength(raw)>12000)finish(fail(503,'Invalid private GPU response.'));});
   response.on('end',()=>{try{if(!valid())throw fail(403,'GPU or task permission changed.');const result=JSON.parse(raw);if(response.statusCode!==200)throw fail(503,'Private GPU is busy or unavailable. Retry after other GPU work finishes, or select GPT only in account settings.');finish(null,result);}catch(e){finish(e.status?e:fail(503,'Invalid private GPU response.'));}});
  });
  request.on('error',()=>finish(fail(503,'Private GPU is unavailable. Check its connection and service. No screenshot was sent to GPT.')));
  const check=setInterval(()=>{if(!valid())finish(fail(403,'GPU or task permission changed.'));},250);
  const timer=setTimeout(()=>finish(fail(504,'Private GPU inspection timed out. No screenshot was sent to GPT.')),85000);
  request.end(payload);
 });
}

function createComputerUseVision({db,ssh,namespace,transport=requestOverSocket}){
 db.exec(`CREATE TABLE IF NOT EXISTS cu_vision_settings(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,connection_id TEXT,revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cu_vision_tests(connection_id TEXT PRIMARY KEY,connection_revision INTEGER NOT NULL,tested_at INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL);`);
 const row=()=>db.prepare('SELECT * FROM cu_vision_settings WHERE id=1').get()||{mode:'gpt',connection_id:null,revision:'initial'};
 const context=()=>({mode:row().mode,model:row().mode==='local'?MODEL:null});
 function connections(){return(ssh?.list('owner',0)||[]).map(c=>({id:c.id,label:c.label,allow_agent:!!c.allow_agent,has_fingerprint:!!c.fingerprint,tested:!!db.prepare('SELECT 1 FROM cu_vision_tests WHERE connection_id=? AND connection_revision=?').get(c.id,c.updated_at)}));}
 function state(){const s=row();return{...context(),connection_id:s.connection_id,connections:connections()};}
 function save(data){
  if(!['gpt','local'].includes(data?.mode))throw fail(400,'Choose GPT only or GPT + my GPU.');
  const cid=data.connection_id??row().connection_id;
  if(cid!==null&&(typeof cid!=='string'||!connections().some(c=>c.id===cid)))throw fail(400,'Choose a GPU connected to this account.');
  if(data.mode==='local'){
   const c=ssh.forService(cid,namespace);
   if(!db.prepare('SELECT 1 FROM cu_vision_tests WHERE connection_id=? AND connection_revision=?').get(cid,c.updated_at))throw fail(409,'Test this GPU successfully before selecting it.');
  }
  db.prepare('INSERT INTO cu_vision_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,connection_id=excluded.connection_id,revision=excluded.revision').run(data.mode,cid,crypto.randomUUID());return state();
 }
 async function request(cid,actor,route,body,valid=()=>{}){
  valid();const c=ssh.forService(cid,actor);
  const check=()=>{try{valid();return ssh.forService(cid,actor).updated_at===c.updated_at;}catch{return false;}};
  const result=await ssh.execute(c,{requireEnabled:true,valid:check,forward:{host:'127.0.0.1',port:PORT},consumeForward:(sock,v)=>transport(sock,route,body,()=>check()&&v())});
  if(!check())throw fail(403,'GPU or task permission changed.');
  if(result?.protocol!==1||result.model!==MODEL)throw fail(503,'This computer is not running the supported private Qwen service. Run GPU setup.');
  return result;
 }
 async function test(cid,valid){
  const c=ssh.forService(cid,namespace);const started=Date.now();
  const image_url='data:image/png;base64,'+fs.readFileSync(path.join(root,'test.png')).toString('base64');
  const result=await request(cid,namespace,'/inspect',{image_url,question:'Read the large heading exactly. Answer only with the heading.'},valid);
  if(!/BOARDLY\s+42/i.test(result.observation||''))throw fail(503,'GPU connected but could not read the test image correctly. Check the model and retry.');
  if(ssh.forService(cid,namespace).updated_at!==c.updated_at)throw fail(409,'GPU connection changed. Test again.');
  const elapsed_ms=Date.now()-started;
  db.prepare('INSERT INTO cu_vision_tests VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET connection_revision=excluded.connection_revision,tested_at=excluded.tested_at,elapsed_ms=excluded.elapsed_ms').run(cid,c.updated_at,Date.now(),elapsed_ms);
  return{ready:true,model:MODEL,elapsed_ms,...state()};
 }
 async function inspect({actor,image_url,question,valid=()=>{}}){
  const before=row();if(before.mode!=='local')throw fail(409,'Local vision is not selected.');
  if(question!==undefined&&(typeof question!=='string'||!question.trim()||question.length>1200))throw fail(400,'Ask a screen question of up to 1200 characters.');
  const check=()=>{valid();if(row().revision!==before.revision)throw fail(409,'Vision mode changed. Inspect the screen again.');};
  const result=await request(before.connection_id,actor,'/inspect',{image_url,...(question?{question}:{})},check);check();
  // Whitelist text and counters. Never relay arbitrary worker fields or the image.
  if(typeof result.observation!=='string'||!result.observation.trim()||result.observation.length>1600||/data:image|base64,/i.test(result.observation))throw fail(503,'Private GPU returned an invalid observation.');
  return{mode:'local',model:MODEL,observation:result.observation,coordinate_system:'normalized_0_1000',elapsed_ms:Number.isSafeInteger(result.elapsed_ms)?result.elapsed_ms:null,untrusted_screen_content:true};
 }
 async function install(cid,valid=()=>{}){
  valid();const c=ssh.forService(cid,namespace);
  const files=Object.fromEntries(['install.py','serve.py'].map(name=>[name,fs.readFileSync(path.join(root,name)).toString('base64')]));
  const script=`import base64,json,os,subprocess,sys\nfrom pathlib import Path\nos.umask(0o077)\nr=Path.home()/'.local/share/boardly-vision'\nr.mkdir(parents=True,exist_ok=True)\nfiles=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(files)).toString('base64')}'))\nfor name,data in files.items(): (r/name).write_bytes(base64.b64decode(data))\nlog=(r/'install.log').open('ab')\nsubprocess.Popen([sys.executable,str(r/'install.py'),'--directory',str(r),'--service'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)\nprint('Setup started')`;
  const encoded=Buffer.from(script).toString('base64');
  const result=await ssh.execute(c,{requireEnabled:true,valid:()=>{try{valid();return ssh.forService(cid,namespace).updated_at===c.updated_at;}catch{return false;}},command:`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`});
  valid();if(result.code!==0)throw fail(503,'Could not start GPU setup. The computer needs Linux, Python 3.11+, curl, Vulkan drivers and a user systemd session.');
  return{status:'installing',message:'Downloading about 6 GB of verified Qwen weights. This can take several minutes.'};
 }
 async function installStatus(cid,valid=()=>{}){
  valid();const c=ssh.forService(cid,namespace);
  const script="import json;from pathlib import Path;p=Path.home()/'.local/share/boardly-vision/install-status.json';print(p.read_text()[:1500] if p.is_file() else json.dumps({'status':'not_installed','message':'Run GPU setup first.'}))";
  const result=await ssh.execute(c,{requireEnabled:true,valid:()=>{try{valid();return ssh.forService(cid,namespace).updated_at===c.updated_at;}catch{return false;}},command:`python3 -c "${script}"`});valid();
  try{const s=JSON.parse(result.stdout);if(!['installing','installed','error','not_installed'].includes(s.status)||typeof s.message!=='string')throw Error();return{status:s.status,message:s.message.slice(0,500)};}catch{throw fail(503,'Could not read GPU setup status. Check the SSH connection.');}
 }
 return{context,state,save,test,inspect,install,installStatus};
}
module.exports={createComputerUseVision,requestOverSocket};
