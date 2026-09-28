const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {fixture}=require('./member-fixture'),{githubFixture}=require('./github-connections');
const {chromium}=require(process.env.BOARDLY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const remote=githubFixture(),f=await fixture({githubRequest:remote.request});let vite,browser,db;
 try{
  await f.api('/api/onboarding',{method:'PUT',body:{step:0,status:'skipped'}});
  const p=await f.project('Active Company','Release project');
  const idle=await f.project('Idle Company','Queued project');
  const done=await f.project('Done Company','Completed project');
  const blocked=await f.project('Blocked Company','Blocked project');
  for(const [project,listName]of[[done,'Done'],[blocked,'Blocked']]){const board=await f.api('/api/boards/'+project.project.id);await f.api('/api/lists/'+board.lists.find(l=>l.name===listName).id+'/cards',{method:'POST',body:{title:'Fixture task'}});}
  const thread=await f.api('/api/boards/'+p.project.id+'/chat/threads',{method:'POST',body:{}});
  const job=await f.api('/api/chat/threads/'+thread.id+'/messages',{method:'POST',body:{mode:'work',content:'Review release'}});
  db=new(require('better-sqlite3'))(path.join(require('../server/cloud').workspacePath(f.root,'user_owner'),'app.db'));
  db.prepare("UPDATE chat_jobs SET status='running',progress='Reviewing source',updated_at=? WHERE id=?").run(Date.now(),job.id);
  const {createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
  vite=await createServer({configFile:false,root:path.resolve('client'),plugins:[react(),tailwind(),{name:'marketing-capture',resolveId(id){if(id==='/capture-entry.jsx')return '\0capture.jsx';},load(id){if(id==='\0capture.jsx')return `import React from 'react';import{createRoot}from'react-dom/client';import{Workspace}from'/src/App.jsx';import{setTokenProvider}from'/src/api.js';import'/src/index.css';setTokenProvider(async()=>${JSON.stringify(f.token('user_owner'))});createRoot(document.getElementById('root')).render(React.createElement(Workspace,{cloud:true,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/capture',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/capture','<!doctype html><html class="dark"><head><title>Boardly</title></head><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/capture-entry.jsx"></script></body></html>'));});}}],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});
  await vite.listen();const url=vite.resolvedUrls.local[0]+'capture';

  browser=await chromium.launch({executablePath:process.env.BOARDLY_CHROME||'/usr/bin/google-chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.goto(url+'#/');
  await page.getByText('Boardly',{exact:true}).waitFor();
  const graph=page.getByRole('region',{name:'All companies agent graph'});
  await graph.getByRole('button',{name:'Open company Active Company',exact:true}).waitFor();
  for(const [name,state]of[['Active Company','working'],['Idle Company','idle'],['Blocked Company','blocked'],['Done Company','done']])assert.equal(await graph.getByRole('button',{name:'Open company '+name,exact:true}).getAttribute('data-state'),state);
  await graph.getByRole('button',{name:'Blocked 1',exact:true}).click();assert.equal(await graph.locator('g[aria-label^="Open company"]').count(),1);
  await graph.getByRole('button',{name:'All companies 4',exact:true}).click();
  await page.route('**/api/agents/companies/dashboard',route=>route.abort());
  await page.waitForFunction(()=>document.querySelector('g[aria-label="Open company Active Company"]')?.dataset.state==='idle',{},{timeout:22000});
  assert.equal(await graph.locator('.overview-flow').count(),0);
  await page.unroute('**/api/agents/companies/dashboard');
  await graph.getByRole('button',{name:'Open company Active Company',exact:true}).press('Enter');
  await page.getByRole('button',{name:'GitHub',exact:true}).click();await page.getByRole('button',{name:'Connect GitHub',exact:true}).click();
  await page.getByLabel('GitHub credential',{exact:true}).selectOption('scoped');
  await page.getByLabel('Repository URL',{exact:true}).fill('https://github.com/fixture/website');
  await page.getByLabel('Target branch',{exact:true}).fill('main');
  const token='github_pat_fixture_browser_'+require('node:crypto').randomBytes(24).toString('hex');
  const secret=page.getByLabel('GitHub access token',{exact:true});assert.equal(await secret.getAttribute('type'),'password');await secret.fill(token);
  await page.getByRole('button',{name:'Save GitHub connection',exact:true}).click();await page.getByText('Work agents enabled',{exact:true}).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes(token));
  await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.getByRole('status').filter({hasText:'Connected to fixture/website'}).waitFor();
  await page.goto(url+'#/board/'+p.project.id);await page.getByRole('button',{name:'GitHub',exact:true}).click();await page.getByText(/Inherited from company/).waitFor();
  await page.getByRole('button',{name:'Use a project repository',exact:true}).click();await page.getByLabel('GitHub credential',{exact:true}).selectOption('scoped');await page.getByLabel('Repository URL',{exact:true}).fill('fixture/project');await page.getByLabel('GitHub access token',{exact:true}).fill(token);await page.getByRole('button',{name:'Save GitHub connection',exact:true}).click();await page.getByRole('link',{name:'fixture/project',exact:true}).waitFor();
  await page.getByRole('button',{name:'Pause agent access',exact:true}).click();await page.getByText('Agent access paused',{exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'GitHub',exact:true}).click();await page.getByText('Agent access paused',{exact:true}).waitFor();
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Remove project connection',exact:true}).click();await page.getByText(/Inherited from company/).waitFor();
  await page.goto(url+'#/');await graph.getByRole('button',{name:'Open Release project',exact:true}).click();assert.ok(page.url().endsWith('#/board/'+p.project.id));
  await page.setViewportSize({width:390,height:844});await page.goto(url+'#/');await graph.getByRole('button',{name:'Open company Active Company',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Companies should fit the mobile page with scroll contained in graph');
  await page.goto(f.base+'/');await page.getByRole('heading',{level:1}).waitFor();
  assert.match(await page.title(),/^Boardly/);assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'),'https://boardlyagent.com/');
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Landing page mobile overflow');}
  const links=await page.locator('a').evaluateAll(nodes=>nodes.map(a=>a.getAttribute('href')));assert.ok(links.filter(h=>h==='/sign-up').length>=3);assert.ok(links.includes('/sign-in'));assert.ok(links.includes('/app'));
  for(const image of await page.locator('img').all()){if(!(await image.isVisible()))continue;await image.scrollIntoViewIfNeeded();await image.evaluate(async img=>{if(!img.complete)await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;});});assert.ok(await image.evaluate(img=>img.naturalWidth>0));}
  const output=process.env.BOARDLY_BROWSER_OUTPUT;if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'landing-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'landing-mobile.png'),fullPage:true});}
  assert.deepEqual(errors,[]);console.log('PASS: company colors, filters, keyboard/navigation, stale heartbeat expiry, GitHub save/test/inheritance/pause/reload/remove, mobile graph and landing, signup links and real screenshots; no browser errors');
 }finally{if(browser)await browser.close();if(vite)await vite.close();if(db)db.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
