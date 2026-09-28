const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fixture}=require('./member-fixture');
(async()=>{
 const desktop_id=crypto.randomUUID(),token='cu_fixture_account_private_123456',frame='data:image/jpeg;base64,/9j/2Q==';let step=0;const seen=[];
 const f=await fixture({computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async()=>({id:'account-one',rentals:[],desktops:[{id:desktop_id,kind:'pilot',state:'active',available:true,memory_mib:6144,label:'8 GB desktop'}]}),computeruseDesktopRequest:async(o,k,c,d)=>{assert.equal(k,token);seen.push(c);if(c==='lease')return{lease:'private-lease',expires:Math.floor(Date.now()/1000)+60};if(c==='screenshot')return{image_url:frame};return{mode:'agent',state:'completed',operation_id:d.operation_id};},providerRequest:async(url,opts)=>{
  if(url.includes('/models/'))return Response.json({id:'gpt-6-astra'});const body=JSON.parse(opts.body);assert.ok(!opts.body.includes(token));assert.ok(!opts.body.includes('private-lease'));
  assert.ok(body.tools.some(t=>t.name==='computer_action'));const calls=['inspect_project_computer','computer_status','computer_screenshot','computer_action','computer_release'];
  if(step===3){const image=body.input.find(i=>i.type==='function_call_output'&&Array.isArray(i.output));assert.equal(image.output[0].image_url,frame);assert.equal(image.output[0].type,'input_image');}
  if(step===4)assert.ok(!opts.body.includes(frame));
  const name=calls[step++],item=name?{type:'function_call',call_id:'call_'+crypto.randomUUID(),name,arguments:JSON.stringify(name==='inspect_project_computer'?{}:{desktop_id,...(name==='computer_action'?{action_json:JSON.stringify({type:'key',key:'Escape'})}:{})})}:{type:'message',role:'assistant',content:[{type:'output_text',text:'Verified desktop tools.'}]};
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',usage:{input_tokens:100,output_tokens:20},output:[item]});
 }});
 try{
  const p=await f.project('Desktop agent','Vision');await f.api('/api/account/computeruse',{method:'PUT',body:{token}});await f.api(`/api/projects/${p.project.id}/computeruse`,{method:'PUT',body:{rental_ids:['desktop:'+desktop_id],allow_agent:true,allow_control:true}});
  await f.api('/api/ai/settings',{method:'PUT',body:{mode:'key',model:'gpt-6-astra',monthly_cap:100,api_key:'sk-fixture_'+crypto.randomBytes(24).toString('hex')}});
  const t=await f.api(`/api/boards/${p.project.id}/chat/threads`,{method:'POST',body:{}});await f.api(`/api/chat/threads/${t.id}/messages`,{method:'POST',body:{mode:'work',content:'Verify the assigned computer.'}});
  let h;for(let i=0;i<200;i++){h=await f.api(`/api/chat/threads/${t.id}`);if(h.job.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(h.job.status,'completed',JSON.stringify(h));assert.equal(step,6);assert.ok(seen.includes('action'));assert.ok(seen.includes('release'));assert.ok(!JSON.stringify(h).includes(frame));
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'boardly-image-test-'));
  try{const payload={input:[{type:'function_call_output',call_id:'screenshot',output:[{type:'input_image',image_url:frame}]}]};const r=require('../scripts/response-images.cjs').responseImages(payload,temp);assert.equal(r.args[0],'--image');assert.equal(fs.statSync(r.args[1]).mode&0o777,0o600);assert.ok(!JSON.stringify(r.payload).includes(frame));assert.throws(()=>require('../scripts/response-images.cjs').responseImages({input:[{type:'function_call_output',output:[{type:'input_image',image_url:'file:///etc/passwd'}]}]},temp));}finally{fs.rmSync(temp,{recursive:true,force:true});}
  console.log('PASS: full hosted Work tool cycle, actual image content format, inputs, release, credential isolation, transient frames, CLI image attachment and malicious image rejection');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
