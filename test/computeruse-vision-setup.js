const assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {createComputerUseVision}=require('../server/computeruse-vision');
(async()=>{
 const db=new Database(':memory:');
 try{
  // Existing installations migrate with sharing disabled and their mode preserved.
  db.exec("CREATE TABLE cu_vision_settings(id INTEGER PRIMARY KEY,mode TEXT,connection_id TEXT,revision TEXT);INSERT INTO cu_vision_settings VALUES(1,'gpt',NULL,'legacy')");
  let revision=1,execs=0,installs=0,malformed=false;
  const found={protocol:1,model:'Qwen3-VL-8B-Instruct-Q4_K_M',os:'Linux',architecture:'x86_64',gpus:[{name:'Fixture GPU',memory_mib:16384,free_mib:13000}],vulkan_available:true,minimum_vram_mib:12000,model_files_present:false,runtime_present:false,service_available:false,needs_install:true,download_bytes:6300000000,disk_free_bytes:20000000000,can_install:true,reasons:[]};
  const ssh={list:()=>[{id:'own',label:'My GPU',allow_agent:true,fingerprint:'fixture',updated_at:revision}],forService:(id,actor)=>{assert.equal(actor,'owner');if(id!=='own')throw Error('GPU not found');return{id,updated_at:revision};},execute:async(c,opts)=>{
   execs++;assert.ok(opts.valid());const script=Buffer.from(opts.command.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/)[1],'base64').toString();
   if(script.includes('def detect(')){assert.ok(!script.includes('Popen'));return{code:0,stdout:JSON.stringify(malformed?{...found,gpus:[{name:{bad:true}}]}:found)};}
   assert.ok(script.includes('install.py'));installs++;return{code:0,stdout:'Setup started'};
  }};
  const vision=createComputerUseVision({db,ssh,namespace:'owner'});
  assert.equal(vision.state().share_with_company,false);assert.equal(vision.state().mode,'gpt');
  assert.throws(()=>vision.save({mode:'gpt',share_with_company:'yes'}),/Choose whether/);
  await assert.rejects(()=>vision.install('own'),/Detect/);assert.equal(execs,0);
  const detected=await vision.detect('own');assert.equal(detected.gpus[0].name,'Fixture GPU');assert.equal(installs,0);assert.ok(vision.state().connections[0].detection.needs_install);
  assert.equal((await vision.install('own')).status,'installing');assert.equal(installs,1);
  found.can_install=false;found.reasons=['Not enough GPU memory'];await vision.detect('own');await assert.rejects(()=>vision.install('own'),/not ready/);assert.equal(installs,1);
  found.can_install=true;await vision.detect('own');db.prepare('UPDATE cu_vision_detections SET detected_at=?').run(Date.now()-31*60*1000);await assert.rejects(()=>vision.install('own'),/Detect/);
  await vision.detect('own');revision++;assert.equal(vision.state().connections[0].detection,null);await assert.rejects(()=>vision.install('own'),/Detect/);
  await assert.rejects(()=>vision.detect('other-account-gpu'),/not found/);
  malformed=true;await assert.rejects(()=>vision.detect('own'),/invalid result/);assert.equal(vision.state().connections[0].detection,null);
  malformed=false;let valid=true;const original=ssh.execute;ssh.execute=async(...args)=>{const result=await original(...args);valid=false;return result;};await assert.rejects(()=>vision.detect('own',()=>{if(!valid)throw Error('revoked');}),/permission or connection changed/);
  console.log('PASS: safe migration, detection without installation, missing-model setup, readiness/freshness gates, connection and permission revocation, cross-account and malformed-result rejection');
 }finally{db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
