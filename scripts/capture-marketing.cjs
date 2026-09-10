// Real UI screenshots from an isolated workspace with demonstration data only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {fixture}=require('../test/member-fixture');
const {chromium}=require(process.env.BOARDLY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const f=await fixture();let vite,browser,desktop;
 const output=path.resolve('client/public/landing/screenshots');fs.mkdirSync(output,{recursive:true});
 try{
  await f.api('/api/onboarding',{method:'PUT',body:{step:0,status:'skipped'}});
  const p=await f.project('Northstar Studio','Website launch');
  await f.api('/api/company-boards/'+p.board.id,{method:'PATCH',body:{name:'Studio operations'}});
  await f.api('/api/projects',{method:'POST',body:{name:'Client onboarding',parent_board_id:p.board.id}});
  await f.api('/api/projects',{method:'POST',body:{name:'September content',parent_board_id:p.board.id}});
  await f.project('Fieldwork Coffee','Autumn collection');
  const finished=await f.project('Brightside Creative','Brand refresh');
  const finishedBoard=await f.api('/api/boards/'+finished.project.id);
  const finishedList=finishedBoard.lists.find(l=>l.name==='Done');
  await f.api('/api/lists/'+finishedList.id+'/cards',{method:'POST',body:{title:'Deliver the brand guidelines'}});
  const active=await f.project('Launch Lab','Product release');
  const activeThread=await f.api('/api/boards/'+active.project.id+'/chat/threads',{method:'POST',body:{}});
  const activeJob=await f.api('/api/chat/threads/'+activeThread.id+'/messages',{method:'POST',body:{mode:'work',content:'Review the release checklist and prepare the launch notes.'}});
  // A simulated heartbeat is demonstration data, never a claim about a real run.
  const demoDb=new(require('better-sqlite3'))(path.join(require('../server/cloud').workspacePath(f.root,'user_owner'),'app.db'));
  demoDb.prepare("UPDATE chat_jobs SET status='running',progress='Reviewing the release checklist',updated_at=? WHERE id=?").run(Date.now(),activeJob.id);
  const board=await f.api('/api/boards/'+p.project.id);
  const titles=[['Map the customer journey','Plan the product photography','Outline the launch newsletter'],['Build the product pages','Connect the checkout flow','Review the mobile experience'],['Approve the final product images'],['Define the visual direction','Write the launch brief','Set up the project workspace']];
  let featured;
  for(let index=0;index<board.lists.length;index++){
   const list=board.lists[index];
   for(const [i,title]of(titles[index]||[]).entries()){
    const card=await f.api('/api/lists/'+list.id+'/cards',{method:'POST',body:{title,description:index===1&&i===0?'Build a clear, welcoming product experience for the autumn launch. Keep the story, product details and buying journey together.\n\nUse the approved direction and check the full journey on desktop and mobile.':'Part of the September launch. Keep decisions and deliverables with this task.',due_date:'2026-09-'+(12+index+i)}});
    if(index===1&&i===0)featured=card;
   }
  }
  const labels=[];
  for(const [name,color]of[['Design','#a78bfa'],['Website','#38bdf8'],['Launch','#34d399']])labels.push(await f.api('/api/boards/'+p.project.id+'/labels',{method:'POST',body:{name,color}}));
  const cards=(await f.api('/api/boards/'+p.project.id)).lists.flatMap(l=>l.cards);
  for(let i=0;i<cards.length;i++)await f.api('/api/cards/'+cards[i].id+'/labels/'+labels[i%3].id,{method:'POST',body:{}});
  const checklist=await f.api('/api/cards/'+featured.id+'/checklists',{method:'POST',body:{title:'Ready for launch'}});
  for(const [i,text]of 'Review the page structure|Add the approved copy|Check the mobile layout|Verify links and checkout'.split('|').entries()){
   const item=await f.api('/api/checklists/'+checklist.id+'/items',{method:'POST',body:{text}});
   if(i<2)await f.api('/api/checklist-items/'+item.id,{method:'PATCH',body:{done:true}});
  }
  await f.api('/api/cards/'+featured.id+'/comments',{method:'POST',body:{author:'Alex',body:'The page structure is approved. The next step is the mobile review and checkout check.'}});
  const {createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
  vite=await createServer({configFile:false,root:path.resolve('client'),plugins:[react(),tailwind(),{name:'marketing-capture',resolveId(id){if(id==='/capture-entry.jsx')return '\0capture.jsx';},load(id){if(id==='\0capture.jsx')return `import React from 'react';import{createRoot}from'react-dom/client';import{Workspace}from'/src/App.jsx';import{setTokenProvider}from'/src/api.js';import'/src/index.css';setTokenProvider(async()=>${JSON.stringify(f.token('user_owner'))});createRoot(document.getElementById('root')).render(React.createElement(Workspace,{cloud:true,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/capture',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/capture','<!doctype html><html class="dark"><head><title>Boardly</title></head><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/capture-entry.jsx"></script></body></html>'));});}}],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});
  await vite.listen();const url=vite.resolvedUrls.local[0]+'capture';
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:780},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'#/board/'+p.project.id);await page.getByText('Build the product pages',{exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:output+'/web-board.png'});
  await page.getByText('Build the product pages',{exact:true}).click();await page.locator('input[value="Ready for launch"]').waitFor();await page.screenshot({path:output+'/web-project.png'});
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'boardly-marketing-desktop-'));
  try{
   desktop=await chromium.launchPersistentContext(profile,{executablePath:'/usr/bin/google-chrome',headless:false,viewport:{width:1280,height:860},args:['--app='+url+'#/company/'+p.company.id,'--window-size=1280,900'],env:{...process.env,DISPLAY:':1',WAYLAND_DISPLAY:'wayland-1',XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'}});
   demoDb.prepare('UPDATE chat_jobs SET updated_at=? WHERE id=?').run(Date.now(),activeJob.id);
   const app=desktop.pages()[0]||await desktop.newPage();await app.goto(url+'#/');await app.getByRole('heading',{name:'Your companies, live',exact:true}).waitFor();await app.getByRole('button',{name:'Open company Northstar Studio',exact:true}).waitFor();await app.evaluate(()=>document.fonts.ready);await app.screenshot({path:output+'/desktop-app.png'});
  }finally{if(desktop)await desktop.close();desktop=null;fs.rmSync(profile,{recursive:true,force:true});}
  demoDb.close();assert.deepEqual(errors,[]);console.log('Saved three real Boardly screenshots from isolated demonstration data.');
 }finally{if(desktop)await desktop.close();if(browser)await browser.close();if(vite)await vite.close();await f.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
