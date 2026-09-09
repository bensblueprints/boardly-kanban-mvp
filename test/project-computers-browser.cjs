const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 f=await fixture();const a=await f.project('Computer Company','Browser work');
 const user=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'computer-member@example.com',role:'editor'}})).member.user_id;
 const tokens=Object.fromEntries(['user_owner',user].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));

 await owner.goto(url+`#/board/${a.project.id}`);await owner.getByRole('button',{name:'Computer use',exact:true}).click();const dialog=owner.getByRole('dialog',{name:'Computer use for Browser work'});
 await dialog.getByText('8 GB RAM',{exact:true}).waitFor();await dialog.getByText('150 GB storage',{exact:true}).waitFor();await dialog.getByText(/Coming soon/).waitFor();await dialog.getByLabel('Number of computers',{exact:true}).fill('8');await dialog.getByText('Planned monthly total: $239.92',{exact:true}).waitFor();
 assert.equal(await dialog.getByRole('button',{name:/Buy|Checkout|Start computer/}).count(),0);await dialog.getByRole('button',{name:'Request availability',exact:true}).click();await dialog.getByRole('status').getByText(/Availability requested for 8 computers/).waitFor();
 await dialog.getByLabel('Number of computers',{exact:true}).fill('2');await dialog.getByRole('button',{name:'Update request',exact:true}).click();await dialog.getByRole('status').getByText(/Availability requested for 2 computers/).waitFor();
 await dialog.getByRole('button',{name:'Close computer use',exact:true}).click();await owner.reload();await owner.getByRole('button',{name:'Computer use',exact:true}).click();await dialog.getByRole('status').getByText(/Availability requested for 2 computers/).waitFor();assert.equal(await dialog.getByLabel('Number of computers',{exact:true}).inputValue(),'2');
 await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/computers-desktop-20260909.png'});
 for(const size of [{width:390,height:844},{width:320,height:568}]){await owner.setViewportSize(size);assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));await dialog.getByRole('button',{name:'Update request',exact:true}).scrollIntoViewIfNeeded();}
 await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/computers-mobile-20260909.png'});
 await member.goto(url+`?user=${user}#/board/${a.project.id}`);await member.getByRole('button',{name:'Computer use',exact:true}).click();const shared=member.getByRole('dialog',{name:'Computer use for Browser work'});await shared.getByText('The account owner manages computer requests and subscriptions.',{exact:true}).waitFor();assert.equal(await shared.getByRole('button',{name:/Request availability|Update request|Cancel request/}).count(),0);
 await dialog.getByRole('button',{name:'Cancel request',exact:true}).click();await dialog.getByRole('button',{name:'Request availability',exact:true}).waitFor();assert.equal((await f.api(`/api/boards/${a.project.id}/computers`)).request,null);assert.deepEqual(errors,[]);
 console.log('PASS: project computer entry point, package and totals, clear prelaunch/no-charge state, saved request/update/cancel/reload, member purchase restrictions and mobile layout');
})().catch(async error=>{console.error(error);if(owner)console.error((await owner.locator('body').innerText()).slice(-2200));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
