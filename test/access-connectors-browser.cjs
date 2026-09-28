const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()],token='cu_fixture_browser_account_key_123456';
 const desktops=ids.map((id,i)=>({id,kind:'pilot',state:'active',available:true,memory_mib:i?12288:6144,vcpus:i?6:4,label:i?'ThinkCentre 16 GB':'ThinkCentre 8 GB'}));
 f=await fixture({huggingFaceRequest:async()=>Response.json({type:'user',name:'fixture-user',orgs:[{name:'test-org',roleInOrg:'admin'}]}),githubRequest:async(t,p,o={})=>p.includes('/collaborators/')?(o.method==='PUT'?{id:12}:{permission:'none'}):p.startsWith('/users/')?{login:'teammate'}:{full_name:'acme/product',permissions:{admin:true},owner:{type:'Organization'}},openWebUIRequest:async()=>Response.json({data:[{id:'webui-tools'}]}),providerConnectorRequest:async()=>Response.json({data:[{id:'claude-fixture-tools'}]}),onepasswordClient:async()=>({vaults:{list:async()=>[{id:'a'.repeat(26),title:'Automation vault'}]},items:{list:async()=>[{id:'b'.repeat(26),title:'QA account',category:'Login',websites:[{url:'https://login.example/'}]}]},secrets:{resolve:async()=>{throw Error('No live secrets in browser QA');}}}),computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async(o,k)=>{assert.equal(k,token);return{id:'account-one',rentals:[],desktops};}});
 const tokens=Object.fromEntries(['user_owner'].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,profile:{name:'Settings Test Owner',email:'settings-owner@example.com'},onManageProfile:()=>{window.profileOpened=true;},onLogout:()=>{window.logoutClicked=true;}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));



 await f.api('/api/account/github',{method:'PUT',body:{token:'github_fixture_private123456789'}});
 await owner.goto(url+'#/settings/github');
 const access=owner.getByRole('region',{name:'GitHub invitations'});
 await access.getByLabel('Repository',{exact:true}).fill('acme/product');
 await access.getByLabel('GitHub username').fill('teammate');
 await access.getByRole('button',{name:'Review access change'}).click();
 await access.getByRole('button',{name:'Confirm Read access for teammate'}).click();
 await access.getByText('Invitation sent · awaiting recipient acceptance').waitFor();
 await owner.goto(url+'#/settings/huggingface');
 await owner.getByLabel('Hugging Face token').fill('hf_fixtureOnly123456789');
 await owner.getByRole('button',{name:'Verify & save connection'}).click();
 await owner.getByText('Connected as fixture-user').waitFor();
 assert.equal(await owner.getByLabel('Hugging Face token').inputValue(),'');
 await owner.getByRole('link',{name:'Manage members on Hugging Face'}).waitFor();
 await owner.setViewportSize({width:390,height:844});
 assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await owner.getByRole('button',{name:'Disconnect',exact:true}).click();
 await owner.getByText('Hugging Face is not connected').waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: GitHub review/confirm invitation receipt and Hugging Face verify, masked key, organizations, disconnect and mobile layout.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await vite?.close();await f?.close();});
