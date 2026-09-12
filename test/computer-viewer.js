const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {viewerFixture}=require('./computer-viewer-fixture');
(async()=>{const v=await viewerFixture(),{f,p,base,desktop_id}=v;try{
 const {job}=await v.start();
 const activity=await f.api('/api/computeruse/activity');assert.equal(activity.activity[0].run_id,job.id);assert.equal(activity.activity[0].desktop_id,desktop_id);
 assert.ok(!JSON.stringify(activity).includes(v.token));assert.ok(!JSON.stringify(activity).includes(v.secret));
 assert.equal((await f.api(base)).mode,'agent');
 assert.equal((await f.request(base+'/screen')).headers.get('content-type'),'image/jpeg');
 assert.equal((await f.api(base+'/takeover',{method:'POST',body:{}})).mode,'human');
 assert.equal((await f.api(base)).can_control,true);
 const id=crypto.randomUUID();await f.api(base+'/action',{method:'POST',body:{operation_id:id,action:{type:'type',text:'Synthetic input'}}});assert.equal(v.inputs.size,1);
 // Viewer and worker use distinct credentials; an agent cannot invoke a human handoff.
 for(const token of [v.worker.token,(await f.api('/api/connections',{method:'POST',body:{name:'Viewer MCP boundary',scope:'mcp'}})).token]){
  assert.equal((await fetch(f.base+base+'/resume',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'})).status,403);
 }
 const ops=await f.api('/api/management?query=computeruse&limit=100');assert.ok(!ops.operations.some(o=>o.path.includes('/view/')||o.path==='/api/computeruse/activity'));
 const mcp=await f.api('/api/connections',{method:'POST',body:{name:'No viewer MCP',scope:'mcp'}});
 const r=await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+mcp.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'call_api_operation',arguments:{operation_id:'POST /api/projects/:id/computeruse/view/:desktopId/resume',parameters:{id:p.project.id,desktopId:desktop_id},body:{}}}})});
 const result=(await r.text()).split('\n').find(x=>x.startsWith('data: '));assert.equal(JSON.parse(result.slice(6)).result.isError,true);assert.equal(v.getMode(),'human');
 const member=(await f.api(`/api/projects/${p.project.id}/members`,{method:'POST',body:{email:'viewer@example.test',role:'editor'}})).member.user_id;
 const options={user:member,workspace:'user_owner'};
 assert.equal((await f.request(base,options)).status,403);assert.equal((await f.api('/api/computeruse/activity',options)).activity.length,0);
 const grant=(await f.api(`/api/projects/${p.project.id}/members`)).members[0].grant_id;
 await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['computers']}});
 assert.equal((await f.api(base,options)).can_control,false);
 assert.equal((await f.request(base+'/screen',options)).status,409);
 assert.equal((await f.request(base+'/resume',{...options,method:'POST',body:{}})).status,409);
 await f.api(base+'/resume',{method:'POST',body:{}});
 let entered,release;const started=new Promise(resolve=>entered=resolve);v.holdScreen(async()=>{entered();await new Promise(resolve=>release=resolve);});
 const pending=f.request(base+'/screen',options);await started;
 await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:[]}});release();assert.equal((await pending).status,403,'Revoke before delivering an in-flight frame');
 const other=await f.project('Other company','No assigned computer');assert.equal((await f.request(`/api/projects/${other.project.id}/computeruse/view/${desktop_id}`)).status,403);
 await v.workerApi(`/api/worker/jobs/${job.id}`,{status:'blocked',blocker:'Awaiting signup',next_action:'Take over then give back',text:'Ready for user signup'});
 assert.equal((await f.api(base+'/takeover',{method:'POST',body:{}})).job.can_resume,true);
 const returned=await f.api(base+'/resume',{method:'POST',body:{}});assert.equal(returned.job.id,job.id);assert.equal(returned.job.can_resume,true);
 await f.api(`/api/projects/${p.project.id}/computeruse`,{method:'PUT',body:{rental_ids:[],allow_agent:false}});
 assert.equal((await f.api('/api/computeruse/activity')).activity.length,0);assert.equal((await f.request(base)).status,403);
 console.log('PASS: native activity, signed per-request viewer delegation, browser-only takeover, MCP exclusion, member/tenant/assignment isolation, human privacy, revocation during frame delivery and saved handoff continuation');
}finally{await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
