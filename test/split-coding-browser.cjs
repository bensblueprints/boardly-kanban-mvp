const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 f=await fixture();const a=await f.project('Clothing Company','Nasdo');
 const added=await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'member@example.com',role:'editor'}}),user=added.member.user_id;
 const projectAdded=await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'project@example.com',role:'editor'}});
 const card=await f.api(`/api/lists/${a.list.id}/cards`,{method:'POST',body:{title:'GitHub task'}});
 const tokens=Object.fromEntries(['user_owner',user,projectAdded.member.user_id].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));
 const boardData=await f.api(`/api/boards/${a.project.id}`);const todo=boardData.lists[0],progress=boardData.lists[1];
 const task=await f.api(`/api/lists/${todo.id}/cards`,{method:'POST',body:{title:'Build the homepage'}});
 for(let n=0;n<12;n++)await f.api(`/api/lists/${todo.id}/cards`,{method:'POST',body:{title:'Task '+n}});
 const saved=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{title:'Saved coding conversation'}});
 await f.api(`/api/chat/threads/${saved.id}/messages`,{method:'POST',body:{mode:'ask',content:'Review the task board. '+('Saved conversation content. '.repeat(70))}});
 await owner.goto(url+`#/board/${a.project.id}`);await owner.getByRole('button',{name:'Chat with AI',exact:true}).click();
 const chat=owner.getByRole('dialog',{name:'Codex chat for Nasdo'}),board=owner.getByRole('region',{name:'Task board',exact:true}),divider=owner.getByRole('separator',{name:'Resize task board and coding pane'});
 await chat.getByText('No GitHub connection saved for this project.',{exact:true}).waitFor();await divider.waitFor();
 async function geometry(side){
  await owner.waitForFunction(side=>document.querySelector('.split-workspace').dataset.layout===(side?'side':'stacked'),side);
  const a=await board.boundingBox(),b=await chat.boundingBox();assert.ok(a.width>190&&a.height>100&&b.width>300&&b.height>100,JSON.stringify({a,b}));
  assert.ok(side?a.x+a.width<=b.x:b.y>=a.y+a.height,'Board and coding pane never overlap');
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page-level horizontal overflow');
  assert.equal(await chat.evaluate(el=>getComputedStyle(el).position),'static');
  return {board:a,chat:b};
 }
 await geometry(true);assert.equal(await chat.getByLabel('Conversation history').inputValue(),saved.id);
 await chat.getByLabel('Message Codex').fill('Keep this unsent draft while resizing.');
 await divider.focus();const old=Number(await divider.getAttribute('aria-valuenow'));await divider.press('ArrowLeft');assert.equal(Number(await divider.getAttribute('aria-valuenow')),old-2);
 const grip=await divider.boundingBox();await owner.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await owner.mouse.down();await owner.mouse.move(grip.x+75,grip.y+grip.height/2,{steps:8});await owner.mouse.up();assert.ok(Number(await divider.getAttribute('aria-valuenow'))>old);await geometry(true);
 assert.equal(await chat.getByLabel('Message Codex').inputValue(),'Keep this unsent draft while resizing.');
 // Real pointer drag-and-drop remains usable beside an open coding pane.
 const draggable=board.locator(`[data-rfd-draggable-id="card-${task.id}"]`),destination=board.locator(`[data-rfd-droppable-id="list-${progress.id}"]`);
 const from=await draggable.boundingBox(),to=await destination.boundingBox();await owner.mouse.move(from.x+from.width/2,from.y+from.height/2);await owner.mouse.down();await owner.mouse.move(from.x+from.width/2+12,from.y+from.height/2,{steps:3});
 await owner.waitForFunction(id=>document.querySelector(`[data-rfd-draggable-id="card-${id}"]`)?.style.position==='fixed',task.id);
 await owner.mouse.move(to.x+to.width/2,to.y+12,{steps:15});await owner.waitForFunction(id=>document.querySelector(`[data-rfd-droppable-id="list-${id}"]`)?.className.includes('bg-indigo-500/5'),progress.id);const moved=owner.waitForResponse(r=>r.url().endsWith(`/api/cards/${task.id}/move`)&&r.request().method()==='POST');await owner.mouse.up();assert.equal((await moved).status(),200);
 await owner.waitForFunction(id=>document.querySelector(`[data-rfd-droppable-id="list-${id}"]`)?.textContent.includes('Build the homepage'),progress.id);
 assert.equal((await f.api(`/api/cards/${task.id}`)).list_id,progress.id);
 await board.getByRole('button',{name:'Add a card',exact:true}).first().click();await board.getByPlaceholder('Card title… (Enter to add)').fill('Added while coding');await board.getByPlaceholder('Card title… (Enter to add)').press('Enter');await board.getByText('Added while coding',{exact:true}).waitFor();assert.equal(await chat.getByLabel('Message Codex').inputValue(),'Keep this unsent draft while resizing.');
 await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/split-coding-desktop-20260908.png'});
 const split=await divider.getAttribute('aria-valuenow');await chat.getByLabel('Close project chat').click();await divider.waitFor({state:'detached'});assert.ok((await board.boundingBox()).width>1400);
 await owner.getByRole('button',{name:'Chat with AI',exact:true}).click();assert.equal(await divider.getAttribute('aria-valuenow'),split);await owner.reload();await owner.getByRole('button',{name:'Chat with AI',exact:true}).click();await chat.getByLabel('Conversation history').waitFor();assert.equal(await divider.getAttribute('aria-valuenow'),split);
 await owner.setViewportSize({width:1024,height:768});await geometry(true);await chat.getByLabel('Message Codex').fill('Laptop draft');await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/split-coding-laptop-20260908.png'});
 await owner.setViewportSize({width:768,height:1024});await geometry(false);assert.equal(await chat.getByLabel('Message Codex').inputValue(),'Laptop draft');
 await owner.setViewportSize({width:390,height:844});await geometry(false);await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/split-coding-mobile-20260908.png'});
 await chat.getByLabel('Message Codex').fill('Mobile draft');await chat.getByRole('button',{name:'Work',exact:true}).click();assert.equal(await chat.getByLabel('Message Codex').inputValue(),'Mobile draft');await divider.focus();await divider.press('ArrowDown');await geometry(false);
 await owner.setViewportSize({width:1440,height:1000});await chat.getByLabel('Close project chat').click();await board.getByText('Build the homepage',{exact:true}).click();await owner.getByRole('button',{name:'Chat about this task',exact:true}).click();await owner.getByRole('button',{name:'Company team chat',exact:true}).waitFor({state:'detached'});await geometry(true);await chat.getByText('Codex · Build the homepage',{exact:true}).waitFor();
 const listHandle=board.locator(`[data-rfd-drag-handle-draggable-id="listwrap-${todo.id}"]`);await listHandle.focus();await listHandle.press('Space');await owner.waitForFunction(id=>document.querySelector(`[data-rfd-draggable-id="listwrap-${id}"]`)?.style.position==='fixed',todo.id);await listHandle.press('ArrowRight');await owner.waitForTimeout(250);const reordered=owner.waitForResponse(r=>r.url().endsWith(`/api/boards/${a.project.id}/lists/reorder`)&&r.request().method()==='POST');await listHandle.press('Space');assert.equal((await reordered).status(),200);assert.equal((await f.api(`/api/boards/${a.project.id}`)).lists[1].id,todo.id);
 assert.deepEqual(errors,[]);console.log('PASS: non-overlapping desktop/laptop/mobile panes, pointer/keyboard resizing and saved ratio, live draft/history preservation, task chat, board editing and real drag-and-drop beside chat');
})().catch(async e=>{console.error(e);if(owner)console.error((await owner.locator('body').innerText()).slice(0,2500));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
