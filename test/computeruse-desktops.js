const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
const {fixture}=require('./member-fixture'),{workspacePath}=require('../server/cloud'),{createComputerUseConnections}=require('../server/computeruse-connections');
(async()=>{
 const token='cu_fixture_desktop_key_secret_12345',desktopId=crypto.randomUUID(),otherId=crypto.randomUUID(),operation_id=crypto.randomUUID();
 const data={id:'account-one',rentals:[],desktops:[{id:desktopId,kind:'pilot',state:'active',available:true,memory_mib:12288,label:'16 GB ThinkCentre',vcpus:6,disk_gib:150,private:'secret host address'}]};
 const f=await fixture({computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async()=>data});let db;
 try{
  const p=await f.project('Computers','Work'),base='/api/account/computeruse',assignment=`/api/projects/${p.project.id}/computeruse`;
  await f.api(base,{method:'PUT',body:{token}});const catalog=await f.api(base+'/rentals');assert.equal(catalog.rentals[0].kind,'pilot');assert.equal(catalog.rentals[0].desktop_id,desktopId);assert.ok(!JSON.stringify(catalog).includes('secret host'));
  await f.api(assignment,{method:'PUT',body:{rental_ids:['desktop:'+desktopId],allow_agent:true,allow_control:true}});
  db=new Database(path.join(workspacePath(f.root,'user_owner'),'app.db'));let human=false,unknown=false,onRequest=()=>{},calls=[];
  const service=createComputerUseConnections({db,key:fs.readFileSync(path.join(f.root,'project-secrets.key')),namespace:'user_owner',origin:'https://api.computeruse.example',request:async()=>data,desktopRequest:async(origin,key,command,args)=>{
   assert.equal(key,token);calls.push(command);onRequest(command);
   if(human&&command!=='status')throw Object.assign(Error('Human control active'),{status:409});
   if(command==='lease')return {lease:'lease-private',expires:Math.floor(Date.now()/1000)+60};
   if(command==='action'&&unknown)throw Object.assign(Error('Unknown outcome'),{status:503});
   if(command==='screenshot')return {image_url:'data:image/jpeg;base64,/9j/2Q=='};
   return {mode:human?'human':'agent',state:'completed'};
  }});
  const run=(job,command,extra={},valid=()=>{})=>service.controlForAgent(p.project.id,'user_owner',job,command,{desktop_id:desktopId,operation_id,action:{type:'key',key:'Escape'},...extra},valid);
  await assert.rejects(()=>run('one','status',{desktop_id:otherId}),/not available/);assert.deepEqual(calls,[]);
  human=true;await assert.rejects(()=>run('one','action'),/Human control/);assert.ok(!calls.includes('action'));human=false;
  await run('one','screenshot');await assert.rejects(()=>run('two','action'),/Another Work agent/);
  await run('one','action');unknown=true;await assert.rejects(()=>run('one','action'),/Unknown outcome/);unknown=false;
  const n=calls.length;await assert.rejects(()=>run('one','action'),/uncertain/);assert.equal(calls.length,n);
  await run('one','screenshot');await run('one','action');await service.releaseRun('one');await run('two','action');
  await service.releaseRun('two');let valid=true;onRequest=c=>{if(c==='lease')valid=false;};const actionCount=calls.filter(x=>x==='action').length;
  await assert.rejects(()=>run('three','action',{},()=>{if(!valid)throw Error('revoked')}),/revoked/);assert.equal(calls.filter(x=>x==='action').length,actionCount);onRequest=()=>{};
  await f.api(assignment,{method:'PUT',body:{rental_ids:[],allow_agent:false}});await assert.rejects(()=>run('four','status'),/No ComputerUse/);
  console.log('PASS: free-desktop catalog, scoped assignment, foreign desktop rejection, human handoff, exclusive run leases, uncertain-input observation, release and in-flight revocation');
 }finally{db?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
