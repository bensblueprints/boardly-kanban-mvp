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

function createComputerUseVision({db,ssh,namespace,transport=requestOverSocket,canUseShared=()=>false}){
 db.exec(`CREATE TABLE IF NOT EXISTS cu_vision_settings(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,connection_id TEXT,revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cu_vision_tests(connection_id TEXT PRIMARY KEY,connection_revision INTEGER NOT NULL,tested_at INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cu_vision_detections(connection_id TEXT PRIMARY KEY,connection_revision INTEGER NOT NULL,detected_at INTEGER NOT NULL,payload TEXT NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(cu_vision_settings)').all().some(c=>c.name==='share_with_company'))db.exec('ALTER TABLE cu_vision_settings ADD COLUMN share_with_company INTEGER NOT NULL DEFAULT 0');
 const row=()=>db.prepare('SELECT * FROM cu_vision_settings WHERE id=1').get()||{mode:'gpt',connection_id:null,revision:'initial'};
 const context=()=>({mode:row().mode,model:row().mode==='local'?MODEL:null,share_with_company:!!row().share_with_company});
 function detection(cid,revision){const d=db.prepare('SELECT * FROM cu_vision_detections WHERE connection_id=? AND connection_revision=?').get(cid,revision);return d?{...JSON.parse(d.payload),detected_at:d.detected_at}:null;}
 function connections(){return(ssh?.list('owner',0)||[]).map(c=>({id:c.id,label:c.label,allow_agent:!!c.allow_agent,has_fingerprint:!!c.fingerprint,tested:!!db.prepare('SELECT 1 FROM cu_vision_tests WHERE connection_id=? AND connection_revision=?').get(c.id,c.updated_at),detection:detection(c.id,c.updated_at)}));}
 function state(){const s=row();return{...context(),connection_id:s.connection_id,connections:connections()};}
 function save(data){
  if(!['gpt','local'].includes(data?.mode))throw fail(400,'Choose GPT only or GPT + my GPU.');
  if(data.share_with_company!==undefined&&typeof data.share_with_company!=='boolean')throw fail(400,'Choose whether company members can use GPU vision.');
  const cid=data.connection_id??row().connection_id;
  if(cid!==null&&(typeof cid!=='string'||!connections().some(c=>c.id===cid)))throw fail(400,'Choose a GPU connected to this account.');
  if(data.mode==='local'){
   const c=ssh.forService(cid,namespace);
   if(!db.prepare('SELECT 1 FROM cu_vision_tests WHERE connection_id=? AND connection_revision=?').get(cid,c.updated_at))throw fail(409,'Test this GPU successfully before selecting it.');
  }
  db.prepare('INSERT INTO cu_vision_settings(id,mode,connection_id,revision,share_with_company) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,connection_id=excluded.connection_id,revision=excluded.revision,share_with_company=excluded.share_with_company').run(data.mode,cid,crypto.randomUUID(),Number(data.share_with_company??!!row().share_with_company));return state();
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
  return{...state(),ready:true,test_model:MODEL,elapsed_ms};
 }
 async function inspect({actor,projectId,image_url,question,valid=()=>{}}){
  const before=row();if(before.mode!=='local')throw fail(409,'Local vision is not selected.');
  if(question!==undefined&&(typeof question!=='string'||!question.trim()||question.length>1200))throw fail(400,'Ask a screen question of up to 1200 characters.');
  const check=()=>{valid();if(row().revision!==before.revision)throw fail(409,'Vision mode changed. Inspect the screen again.');if(actor!==namespace&&(!before.share_with_company||!canUseShared(actor,projectId)))throw fail(403,'The owner must share GPU vision with your company and enable your Computer use permission.');};
  check();
  // Company sharing delegates this fixed vision request only. It never changes
  // SSH visibility, grants shell access, or exposes the owner's connection key.
  const result=await request(before.connection_id,namespace,'/inspect',{image_url,...(question?{question}:{})},check);check();
  // Whitelist text and counters. Never relay arbitrary worker fields or the image.
  if(typeof result.observation!=='string'||!result.observation.trim()||result.observation.length>1600||/data:image|base64,/i.test(result.observation))throw fail(503,'Private GPU returned an invalid observation.');
  return{mode:'local',model:MODEL,observation:result.observation,coordinate_system:'normalized_0_1000',elapsed_ms:Number.isSafeInteger(result.elapsed_ms)?result.elapsed_ms:null,untrusted_screen_content:true};
 }
 async function install(cid,valid=()=>{}){
  valid();const c=ssh.forService(cid,namespace);
  const found=detection(cid,c.updated_at);
  if(!found||Date.now()-found.detected_at>30*60*1000)throw fail(409,'Detect the GPU and model files before installation.');
  if(!found.can_install)throw fail(409,'This computer is not ready for vision installation. Check its GPU detection results.');
  const files=Object.fromEntries(['install.py','serve.py'].map(name=>[name,fs.readFileSync(path.join(root,name)).toString('base64')]));
  const script=`import base64,json,os,subprocess,sys\nfrom pathlib import Path\nos.umask(0o077)\nr=Path.home()/'.local/share/boardly-vision'\nr.mkdir(parents=True,exist_ok=True)\nfiles=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(files)).toString('base64')}'))\nfor name,data in files.items(): (r/name).write_bytes(base64.b64decode(data))\nlog=(r/'install.log').open('ab')\nsubprocess.Popen([sys.executable,str(r/'install.py'),'--directory',str(r),'--service'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)\nprint('Setup started')`;
  const encoded=Buffer.from(script).toString('base64');
  const result=await ssh.execute(c,{requireEnabled:true,valid:()=>{try{valid();return ssh.forService(cid,namespace).updated_at===c.updated_at;}catch{return false;}},command:`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`});
  valid();if(result.code!==0)throw fail(503,'Could not start GPU setup. The computer needs Linux, Python 3.11+, curl, Vulkan drivers and a user systemd session.');
  return{status:'installing',message:found.download_bytes>0?'Installing missing Qwen files and verifying the setup. This can take several minutes.':'Verifying the existing Qwen files and repairing the vision service.'};
 }
 async function installStatus(cid,valid=()=>{}){
  valid();const c=ssh.forService(cid,namespace);
  const script="import json;from pathlib import Path;p=Path.home()/'.local/share/boardly-vision/install-status.json';print(p.read_text()[:1500] if p.is_file() else json.dumps({'status':'not_installed','message':'Run GPU setup first.'}))";
  const result=await ssh.execute(c,{requireEnabled:true,valid:()=>{try{valid();return ssh.forService(cid,namespace).updated_at===c.updated_at;}catch{return false;}},command:`python3 -c "${script}"`});valid();
  try{const s=JSON.parse(result.stdout);if(!['installing','installed','error','not_installed'].includes(s.status)||typeof s.message!=='string')throw Error();return{status:s.status,message:s.message.slice(0,500)};}catch{throw fail(503,'Could not read GPU setup status. Check the SSH connection.');}
 }
 async function detect(cid,valid=()=>{}){
  valid();const c=ssh.forService(cid,namespace),encoded=fs.readFileSync(path.join(root,'detect.py')).toString('base64');
  const check=()=>{try{valid();return ssh.forService(cid,namespace).updated_at===c.updated_at;}catch{return false;}};
  const result=await ssh.execute(c,{requireEnabled:true,valid:check,command:`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`});
  if(!check())throw fail(403,'GPU permission or connection changed.');
  let found;try{found=JSON.parse(result.stdout);}catch{throw fail(503,'GPU detection could not run. Check the SSH connection and Python installation.');}
  if(result.code!==0||found?.protocol!==1||found.model!==MODEL||!Array.isArray(found.gpus)||found.gpus.length>16||found.gpus.some(g=>!g||typeof g.name!=='string'||g.name.length>160||!Number.isSafeInteger(g.memory_mib)||g.memory_mib<0||!Number.isSafeInteger(g.free_mib)||g.free_mib<0)||['os','architecture'].some(k=>typeof found[k]!=='string'||found[k].length>80)||['can_install','needs_install','model_files_present','runtime_present','service_available','vulkan_available'].some(k=>typeof found[k]!=='boolean')||['download_bytes','disk_free_bytes','minimum_vram_mib'].some(k=>!Number.isSafeInteger(found[k])||found[k]<0)||!Array.isArray(found.reasons)||found.reasons.some(r=>typeof r!=='string'||r.length>500)||JSON.stringify(found).length>12000)throw fail(503,'GPU detection returned an invalid result.');
  const at=Date.now();db.prepare('INSERT INTO cu_vision_detections VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET connection_revision=excluded.connection_revision,detected_at=excluded.detected_at,payload=excluded.payload').run(cid,c.updated_at,at,JSON.stringify(found));
  return{...found,detected_at:at};
 }
 return{context,state,save,test,inspect,install,installStatus,detect};
}
module.exports={createComputerUseVision,requestOverSocket};
