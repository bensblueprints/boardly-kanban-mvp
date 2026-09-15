const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture'),{connectorFixture}=require('./chatgpt-fixture.cjs');
const {chromium}=require(process.env.BOARDLY_PLAYWRIGHT_MODULE||'/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
(async()=>{
 const c=await connectorFixture(),f=await fixture({chatgpt:{url:c.url,token:c.token}});let vite,browser;
 try{
  const project=await f.project('Employee QA','Named team');
  await f.api('/api/ai/chatgpt/login',{method:'POST'});await c.approve('user_owner','owner@example.com');await f.api('/api/ai/chatgpt/activate',{method:'POST'});
  const task=await f.api(`/api/lists/${project.list.id}/cards`,{method:'POST',body:{title:'Review the current authorized task'}});
  const {createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
  vite=await createServer({configFile:false,root:path.resolve('client'),plugins:[react(),tailwind(),{name:'employee-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0employee-qa';},load(id){if(id==='\0employee-qa')return `import React from 'react';import{createRoot}from'react-dom/client';import{Workspace}from'/src/App.jsx';import{setTokenProvider}from'/src/api.js';import'/src/index.css';setTokenProvider(async()=>${JSON.stringify(f.token('user_owner'))});createRoot(document.getElementById('root')).render(React.createElement(Workspace,{cloud:true,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}}],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(vite.resolvedUrls.local[0]+`qa#/board/${project.project.id}`);await page.getByRole('button',{name:'Set up later',exact:true}).click();await page.getByRole('button',{name:'Chat with AI',exact:true}).click();
  await page.getByRole('button',{name:'Employees',exact:true}).click();const team=page.getByRole('region',{name:'Project employees'});
  await team.getByText('Continuous team paused',{exact:true}).waitFor();assert.equal(await team.getByRole('heading',{level:4}).filter({hasText:/Morgan|Alex|Sam|Casey/}).count(),4);
  const roster=await f.api(`/api/boards/${project.project.id}/employees`);await team.getByLabel('Employee',{exact:true}).selectOption(roster.employees.find(e=>e.name==='Casey').id);await team.getByLabel('Assignment task number').fill(String(task.id));await team.getByLabel('Assignment instructions').fill('Read the assigned task and return the verification result.');
  await team.getByRole('button',{name:'Assign task',exact:true}).click();await team.getByRole('link',{name:'Open assignment',exact:true}).waitFor();
  await team.getByLabel('Team message',{exact:true}).fill('Keep the reviewed output linked to the task.');await team.getByRole('button',{name:'Save team message',exact:true}).click();await team.getByText('Keep the reviewed output linked to the task.',{exact:true}).waitFor();
  await team.getByRole('button',{name:'Enable continuous team',exact:true}).click();await team.getByText('Continuous team enabled',{exact:true}).waitFor();await team.getByRole('button',{name:'Pause new assignments',exact:true}).click();await team.getByText('Continuous team paused',{exact:true}).waitFor();
  await page.screenshot({path:'/home/ben/.local/share/boardly-ops/reliability-20260915/employees-desktop.png',fullPage:true});
  await team.getByRole('link',{name:'Open assignment',exact:true}).click();await page.getByRole('dialog').getByLabel('Conversation history').waitFor();assert.ok(page.url().includes('?chat='));
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Employees',exact:true}).click();await page.getByRole('region',{name:'Project employees'}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  console.log('PASS: real API roster, named task assignment, shared message, continuous dispatch toggle, saved conversation link, mobile layout and no browser errors');
 }finally{await browser?.close();await vite?.close();await f.close();await c.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
