const assert=require('node:assert/strict');
const path=require('node:path');
const {fixture}=require('./member-fixture');
const {chromium}=require(process.env.BOARDLY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const f=await fixture({publicAccess:true,providerConnectorRequest:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-test'}]});
  const body=JSON.parse(options.body),done=body.messages.some(m=>m.role==='tool');
  const message=done?{content:'The Marketing department, Launch Board, task and AI team are ready.'}:{content:null,tool_calls:[{id:'build',type:'function',function:{name:'build_company_structure',arguments:JSON.stringify({request_key:'browser-setup',departments:[{name:'Marketing',description:'Customer acquisition',boards:[{name:'Launch',description:'First campaign',tasks:[{title:'Draft launch brief',description:'Prepare draft only'}]}]}]})}}]};
  return Response.json({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1}});
 }});
 let browser,vite;
 try{
  const company=await f.api('/api/companies',{method:'POST',body:{name:'Company Builder Test'}});
  await f.api(`/api/companies/${company.id}/ai/providers/deepseek`,{method:'PUT',body:{token:'browser-test-key'}});
  await f.api(`/api/companies/${company.id}/ai`,{method:'PUT',body:{source:'company',provider:'deepseek',model:'deepseek-test'}});
  const {createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
  vite=await createServer({configFile:false,root:path.resolve('client'),plugins:[react(),tailwind(),{
   name:'company-work-fixture',resolveId:id=>id==='/fixture.jsx'?'\0fixture':null,
   load:id=>id==='\0fixture'?`import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:'user_owner',getToken:async()=>${JSON.stringify(f.token('user_owner'))},profile:{name:'Test Owner',email:'owner@example.com'}}));`:null,
   configureServer(server){server.middlewares.use('/qa',async(req,res)=>{res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>'));});}
  }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});
  await vite.listen();browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(vite.resolvedUrls.local[0]+`qa#/company/${company.id}`);
  await page.getByRole('button',{name:'Set up later',exact:true}).click();
  await page.getByRole('button',{name:'Chat with AI / Agent swarm',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'company AI',exact:true});
  await dialog.getByRole('button',{name:/^Work Build and run/}).click();
  await dialog.getByLabel('AI message').fill('Create a Marketing department, Launch Board, draft task and AI team. Do not start work yet.');
  const submit=dialog.getByRole('button',{name:'Build / run company',exact:true});assert.equal(await submit.isEnabled(),true,'Empty company can submit Work without selecting existing Boards');
  await submit.click();
  await dialog.getByLabel('Company structure created').waitFor();
  await dialog.getByText('Added 1 departments, 1 Boards and 1 tasks.',{exact:true}).waitFor();
  await dialog.getByText('4 AI employees · 1 tasks',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  const bounds=await submit.boundingBox();assert.ok(bounds.width>0&&bounds.x>=0&&bounds.x+bounds.width<=390);
  const text=await dialog.innerText();assert.ok(!text.includes('Add a project to this company before starting agents'));
  await dialog.getByRole('button',{name:/Marketing \/ Launch/}).click();
  await page.getByText('Draft launch brief',{exact:true}).first().waitFor();
  assert.equal((await f.api('/api/hierarchy')).projects.length,1);assert.deepEqual(errors,[]);
  console.log('PASS: company Work from an empty company, visible created structure and employee counts, working Board link, mobile layout, no page errors.');
 }finally{await browser?.close();await vite?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
