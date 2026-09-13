const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()],token='cu_fixture_browser_account_key_123456';
 const desktops=ids.map((id,i)=>({id,kind:'pilot',state:'active',available:true,memory_mib:i?12288:6144,vcpus:i?6:4,label:i?'ThinkCentre 16 GB':'ThinkCentre 8 GB'}));
 f=await fixture({computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async(o,k)=>{assert.equal(k,token);return{id:'account-one',rentals:[],desktops};}});
 const a=await f.project('Computer Company A','Browser work A'),b=await f.project('Computer Company B','Browser work B');
 const user=(await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'computer-member@example.com',role:'editor'}})).member.user_id;
 const tokens=Object.fromEntries(['user_owner',user].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));

 await owner.goto(url+'#/');
 await owner.getByRole('button',{name:'Set up later',exact:true}).click();
 let account=owner.getByRole('region',{name:'Account ComputerUse'});
 await account.getByLabel('ComputerUse API key',{exact:true}).fill(token);await account.getByRole('button',{name:'Connect ComputerUse',exact:true}).click();
 await account.getByText('API connected',{exact:true}).waitFor();await account.getByText('ThinkCentre 16 GB',{exact:true}).waitFor();
 assert.equal(await account.locator('article').count(),2);assert.ok(!(await owner.locator('body').innerText()).includes('$29.99'));assert.ok(!(await owner.locator('body').innerText()).includes(token));
 await account.getByLabel('Company for computer assignment').selectOption(String(a.company.id));await account.getByRole('button',{name:'Open company',exact:true}).click();
 let panel=owner.getByRole('region',{name:'Company computers',exact:true});
 await panel.getByRole('checkbox',{name:/ThinkCentre 8 GB/}).check();await panel.getByRole('button',{name:'Save assignment',exact:true}).click();await panel.getByRole('status').getByText('Computer assignment saved.',{exact:true}).waitFor();
 assert.deepEqual((await f.api(`/api/companies/${a.company.id}/computeruse`)).rental_ids,['desktop:'+ids[0]]);
 await owner.goto(url+'#/');account=owner.getByRole('region',{name:'Account ComputerUse'});await account.getByText('ThinkCentre 16 GB',{exact:true}).waitFor();
 await account.getByLabel('Company for computer assignment').selectOption(String(b.company.id));await account.getByRole('button',{name:'Open company',exact:true}).click();
 panel=owner.getByRole('region',{name:'Company computers',exact:true});await panel.getByRole('checkbox',{name:/ThinkCentre 16 GB/}).check();assert.equal(await panel.getByRole('checkbox',{name:/ThinkCentre 8 GB/}).isChecked(),false);
 await panel.getByRole('button',{name:'Save assignment',exact:true}).click();await panel.getByRole('status').getByText('Computer assignment saved.',{exact:true}).waitFor();
 await owner.reload();panel=owner.getByRole('region',{name:'Company computers',exact:true});await panel.getByRole('checkbox',{name:/ThinkCentre 16 GB/}).waitFor();assert.equal(await panel.getByRole('checkbox',{name:/ThinkCentre 16 GB/}).isChecked(),true);
 assert.deepEqual((await f.api(`/api/companies/${a.company.id}/computeruse`)).rental_ids,['desktop:'+ids[0]]);
 assert.deepEqual((await f.api(`/api/companies/${b.company.id}/computeruse`)).rental_ids,['desktop:'+ids[1]]);
 const hub=await f.api(`/api/agents/company/${b.company.id}`);assert.deepEqual(hub.computers[0].rental_ids,['desktop:'+ids[1]]);assert.equal(hub.computers[0].allow_control,true);
 await owner.setViewportSize({width:390,height:844});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await owner.screenshot({path:'/tmp/boardly-cu-company-home-mobile.png',fullPage:true});
 await owner.setViewportSize({width:1440,height:1000});await owner.goto(url+`#/board/${b.project.id}`);await owner.getByRole('button',{name:'Computer use',exact:true}).click();const dialog=owner.getByRole('dialog',{name:'Computer use for Browser work B'});
 await dialog.getByText('Inherited from company · 1 computer(s)',{exact:true}).waitFor();assert.equal(await dialog.getByRole('checkbox',{name:/ThinkCentre 16 GB/}).isChecked(),true);assert.equal(await dialog.getByRole('checkbox',{name:/ThinkCentre 8 GB/}).isChecked(),false);
 assert.deepEqual(errors,[]);assert.ok(!(await owner.locator('body').innerText()).includes('$29.99'));
 console.log('PASS: Companies-home API connection/inventory, independent company selections, persistence, inherited project control, company-agent discovery, no stale price, no page errors and mobile layout');
})().catch(async error=>{console.error(error);if(owner)console.error((await owner.locator('body').innerText()).slice(-2200));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
