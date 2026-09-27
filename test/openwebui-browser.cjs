const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()],token='cu_fixture_browser_account_key_123456';
 const desktops=ids.map((id,i)=>({id,kind:'pilot',state:'active',available:true,memory_mib:i?12288:6144,vcpus:i?6:4,label:i?'ThinkCentre 16 GB':'ThinkCentre 8 GB'}));
 f=await fixture({openWebUIRequest:async()=>Response.json({data:[{id:'webui-tools'}]}),providerConnectorRequest:async()=>Response.json({data:[{id:'claude-fixture-tools'}]}),onepasswordClient:async()=>({vaults:{list:async()=>[{id:'a'.repeat(26),title:'Automation vault'}]},items:{list:async()=>[{id:'b'.repeat(26),title:'QA account',category:'Login',websites:[{url:'https://login.example/'}]}]},secrets:{resolve:async()=>{throw Error('No live secrets in browser QA');}}}),computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async(o,k)=>{assert.equal(k,token);return{id:'account-one',rentals:[],desktops};}});
 const tokens=Object.fromEntries(['user_owner'].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,profile:{name:'Settings Test Owner',email:'settings-owner@example.com'},onManageProfile:()=>{window.profileOpened=true;},onLogout:()=>{window.logoutClicked=true;}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));


 await owner.goto(url+'#/settings/openwebui');
 await owner.getByLabel('Open WebUI server URL').fill('https://models.example.com');
 await owner.getByLabel('Open WebUI API key').fill('browser-fixture-key');
 await owner.getByRole('button',{name:'Verify connection',exact:true}).click();
 await owner.getByRole('status').getByText('Connection verified.',{exact:false}).waitFor();
 assert.equal(await owner.getByLabel('Open WebUI API key').inputValue(),'');
 await owner.getByRole('button',{name:'Use for Boardly agents',exact:true}).click();
 await owner.getByRole('heading',{name:'Selected for Boardly agents',exact:true}).waitFor();
 await owner.setViewportSize({width:390,height:844});
 assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await owner.screenshot({path:'/tmp/boardly-openwebui-settings.png',fullPage:true});
 await owner.getByRole('button',{name:'Disconnect',exact:true}).click();
 await owner.getByRole('heading',{name:'Selected · reconnect to resume',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: Open WebUI settings verify, key clearing, model activation, disconnect and mobile layout.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await vite?.close();await f?.close();});
