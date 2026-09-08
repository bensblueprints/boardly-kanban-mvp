const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 f=await fixture({githubRequest:async()=>[]});const a=await f.project('Clothing Company','Nasdo');
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
 await owner.goto(url+`#/board/${a.project.id}`);await owner.getByRole('button',{name:'Chat with AI',exact:true}).click();
 const chat=owner.getByRole('dialog',{name:'Codex chat for Nasdo'});await chat.getByText('No GitHub connection saved for this project.',{exact:true}).waitFor();
 await chat.getByRole('button',{name:'Connect GitHub',exact:true}).click();await chat.getByRole('button',{name:'Connect GitHub',exact:true}).click();
 await chat.getByLabel('Repository URL',{exact:true}).fill('https://github.com/northstar/website');await chat.getByLabel('Target branch',{exact:true}).fill('production');
 await chat.getByLabel('GitHub credential',{exact:true}).selectOption('scoped');
 const token='github_pat_browser_fixture_123456789012345678901234567890';await chat.getByLabel('GitHub access token',{exact:true}).fill(token);await chat.getByRole('button',{name:'Save GitHub connection',exact:true}).click();
 await chat.getByText('GitHub connection saved for all chats in this scope. Test access to verify the repository and branch.',{exact:true}).waitFor();
 await chat.getByRole('button',{name:'Close GitHub settings',exact:true}).click();await chat.getByText('GitHub: northstar/website · production',{exact:true}).waitFor({timeout:6500});
 const old=await f.api(`/api/boards/${a.project.id}/chat/threads`,{method:'POST',body:{title:'Earlier conversation'}});
 await owner.reload();await owner.getByRole('button',{name:'Chat with AI',exact:true}).click();await chat.getByText('GitHub: northstar/website · production',{exact:true}).waitFor();
 await chat.getByRole('button',{name:'Start new conversation',exact:true}).click();await chat.getByText('GitHub: northstar/website · production',{exact:true}).waitFor();await chat.getByLabel('Conversation history').selectOption(old.id);await chat.getByText('GitHub: northstar/website · production',{exact:true}).waitFor();
 await chat.getByRole('button',{name:'GitHub settings',exact:true}).click();await chat.getByRole('button',{name:'Edit connection',exact:true}).click();assert.equal(await chat.getByLabel('GitHub access token',{exact:true}).inputValue(),'');
 await chat.getByLabel('Target branch',{exact:true}).fill('next-release');await chat.getByRole('button',{name:'Save GitHub connection',exact:true}).click();await chat.getByRole('button',{name:'Edit connection',exact:true}).waitFor();await chat.getByRole('button',{name:'Close GitHub settings',exact:true}).click();await chat.getByText('GitHub: northstar/website · next-release',{exact:true}).waitFor({timeout:6500});
 await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/github-chat-desktop.png'});
 await owner.getByLabel('Close project chat').click();await owner.getByText('GitHub task',{exact:true}).click();await owner.getByRole('button',{name:'Chat about this task',exact:true}).click();await chat.getByText('GitHub: northstar/website · next-release',{exact:true}).waitFor();
 await owner.getByRole('button',{name:'Company team chat',exact:true}).waitFor({state:'detached'});await owner.setViewportSize({width:390,height:844});await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/github-chat-mobile.png'});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await member.goto(url+`?user=${user}#/board/${a.project.id}`);await member.getByRole('button',{name:'Chat with AI',exact:true}).click();await member.getByText('GitHub access is managed by the company owner.',{exact:true}).waitFor();assert.ok(!(await member.locator('body').innerText()).includes('northstar/website'));
 const grant=(await f.api(`/api/companies/${a.company.id}/members`)).members[0].grant_id;await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:['github']}});await member.getByText('GitHub: northstar/website · next-release',{exact:true}).waitFor({timeout:6500});
 await f.api(`/api/memberships/${grant}`,{method:'PATCH',body:{scopes:[]}});await member.getByText('GitHub access is managed by the company owner.',{exact:true}).waitFor({timeout:6500});
 assert.ok(!(await owner.locator('body').innerText()).includes(token));assert.deepEqual(errors,[]);console.log('PASS: GitHub save from chat, reload, new/existing/task conversation reuse, blank-token edit, live permission changes and desktop/mobile layout');
})().catch(async e=>{console.error(e);if(owner)console.error((await owner.locator('body').innerText()).slice(0,2500));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
