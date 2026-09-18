const assert=require('node:assert/strict'),crypto=require('node:crypto'),{fixture}=require('./member-fixture');
(async()=>{
 let steps=0,submitted=0;const requestKey=crypto.randomUUID(),remote=crypto.randomUUID();
 const f=await fixture({publicAccess:true,providerRequest:async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer sk-fixture_customer_key_123456789012345');
  if(url.includes('/models/'))return Response.json({});const body=JSON.parse(options.body);assert.ok(body.tools.some(t=>t.name==='media_generate'));assert.ok(!options.body.includes('fixture-media-secret'));
  let output;if(steps===0)output=[{type:'function_call',call_id:'media_list',name:'media_connections',arguments:'{}'}];
  else if(steps===1)output=[{type:'function_call',call_id:'media_create',name:'media_generate',arguments:JSON.stringify({provider:'fal',prompt:'Authorized illustration',request_key:requestKey})}];
  else if(steps===2){const j=JSON.parse(body.input.find(i=>i.call_id==='media_create'&&i.type==='function_call_output').output);output=[{type:'function_call',call_id:'media_status',name:'media_status',arguments:JSON.stringify({job_id:j.id})}];}
  else{assert.ok(options.body.includes('https://media.example/hosted.png'));output=[{type:'message',role:'assistant',content:[{type:'output_text',text:'Generated image: https://media.example/hosted.png'}]}];}steps++;
  return Response.json({id:'resp_'+crypto.randomUUID(),model:'gpt-6-astra',status:'completed',service_tier:'default',usage:{input_tokens:100,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens:30},output});
 },mediaRequest:async(url,options)=>{assert.equal(options.headers.Authorization,'Key fixture-media-secret');if(options.method==='POST'){submitted++;return Response.json({request_id:remote,status_url:`https://queue.fal.run/fal-ai/flux/requests/${remote}/status`,response_url:`https://queue.fal.run/fal-ai/flux/requests/${remote}`,cancel_url:`https://queue.fal.run/fal-ai/flux/requests/${remote}/cancel`});}return Response.json(url.endsWith('/status')?{status:'COMPLETED'}:{images:[{url:'https://media.example/hosted.png'}]});}});
 try{
  const user='user_customer',p=await f.project('Customer media','Project',user),post=(route,body)=>f.api(route,{user,method:'POST',body}),put=(route,body)=>f.api(route,{user,method:'PUT',body});
  await put('/api/ai/settings',{mode:'key',model:'gpt-6-astra',monthly_cap:20,api_key:'sk-fixture_customer_key_123456789012345'});
  await put('/api/account/media/fal',{token:'fixture-media-secret',model:'fal-ai/flux/schnell',defaults:{},daily_limit:2});await put(`/api/projects/${p.project.id}/media/fal`,{enabled:true});
  const t=await post(`/api/boards/${p.project.id}/chat/threads`,{});await post(`/api/chat/threads/${t.id}/messages`,{mode:'work',content:'Generate an illustration using my fal account'});
  let chat;for(let i=0;i<100;i++){chat=await f.api(`/api/chat/threads/${t.id}`,{user});if(!['queued','running'].includes(chat.job.status))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(chat.job.status,'completed',JSON.stringify(chat.job));assert.equal(submitted,1);assert.equal(steps,4);assert.match(chat.messages.at(-1).content,/Generated image/);assert.ok(!JSON.stringify(chat).includes('fixture-media-secret'));
 }finally{await f.close();}console.log('PASS: customer hosted Work agent lists, submits and retrieves media with scoped tool calls and no exposed API keys');
})().catch(e=>{console.error(e);process.exitCode=1;});
