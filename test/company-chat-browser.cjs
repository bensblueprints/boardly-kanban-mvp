const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 f=await fixture();const a=await f.project('Clothing Company','Nasdo');
 const added=await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'member@example.com',role:'viewer'}}),user=added.member.user_id;
 const projectAdded=await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'project@example.com',role:'editor'}});
 const card=await f.api(`/api/lists/${a.list.id}/cards`,{method:'POST',body:{title:'Prepare the clothing launch'}});
 const tokens=Object.fromEntries(['user_owner',user,projectAdded.member.user_id].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));
 await owner.goto(url+`#/company/${a.company.id}`);await owner.getByRole('button',{name:'Team chat',exact:true}).click();
 await owner.getByLabel('Message company team').fill('Ready for the clothing launch.');await owner.getByRole('button',{name:'Send',exact:true}).click();await owner.getByText('Ready for the clothing launch.',{exact:true}).waitFor();
 await member.goto(url+`?user=${user}#/board/${a.project.id}`);await member.getByText('Prepare the clothing launch',{exact:true}).click();await member.getByRole('button',{name:'Company team chat',exact:true}).click();
 await member.getByText('Ready for the clothing launch.',{exact:true}).waitFor();assert.equal(await member.getByLabel('Message company team').isDisabled(),false,'Viewer can participate without task-edit permissions');
 await member.getByLabel('Message company team').fill('I will check the shirt photos.');await member.getByRole('button',{name:'Send',exact:true}).click();await owner.getByText('I will check the shirt photos.',{exact:true}).waitFor({timeout:6500});
 await owner.getByText('Task: Prepare the clothing launch',{exact:true}).waitFor();await owner.getByText('member@example.com',{exact:true}).waitFor();
 await member.reload();await member.getByText('Prepare the clothing launch',{exact:true}).click();await member.getByRole('button',{name:'Company team chat',exact:true}).click();await member.getByText('I will check the shirt photos.',{exact:true}).waitFor();
 await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/company-chat-desktop.png'});
 await member.setViewportSize({width:390,height:844});await member.screenshot({path:'/home/ben/.local/share/boardly-ops/company-chat-task-mobile.png'});assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const grant=(await f.api(`/api/companies/${a.company.id}/members`)).members[0].grant_id;await f.api(`/api/memberships/${grant}`,{method:'DELETE'});
 await member.getByText('I will check the shirt photos.',{exact:true}).waitFor({state:'detached',timeout:6500});
 assert.deepEqual(errors,[]);console.log('PASS: company and task chat share live history, Viewer participation, refresh persistence, sender/task attribution, mobile layout and access revocation');
})().catch(async e=>{console.error(e);if(owner)console.error((await owner.locator('body').innerText()).slice(0,1800));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
