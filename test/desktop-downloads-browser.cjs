const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()],token='cu_fixture_browser_account_key_123456';
 const desktops=ids.map((id,i)=>({id,kind:'pilot',state:'active',available:true,memory_mib:i?12288:6144,vcpus:i?6:4,label:i?'ThinkCentre 16 GB':'ThinkCentre 8 GB'}));
 f=await fixture({providerConnectorRequest:async()=>Response.json({data:[{id:'claude-fixture-tools'}]}),onepasswordClient:async()=>({vaults:{list:async()=>[{id:'a'.repeat(26),title:'Automation vault'}]},items:{list:async()=>[{id:'b'.repeat(26),title:'QA account',category:'Login',websites:[{url:'https://login.example/'}]}]},secrets:{resolve:async()=>{throw Error('No live secrets in browser QA');}}}),computeruseOrigin:'https://api.computeruse.example',computeruseRequest:async(o,k)=>{assert.equal(k,token);return{id:'account-one',rentals:[],desktops};}});
 const a=await f.project('Computer Company A','Browser work A'),b=await f.project('Computer Company B','Browser work B');
 const membership=(await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'computer-member@example.com',role:'viewer'}}));const user=membership.member.user_id;
 const tokens=Object.fromEntries(['user_owner',user].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,profile:{name:'Settings Test Owner',email:'settings-owner@example.com'},onManageProfile:()=>{window.profileOpened=true;},onLogout:()=>{window.logoutClicked=true;}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));

 const go=async(hash,page=owner)=>{await page.goto(url+hash);};
 const nav=scope=>owner.getByRole('navigation',{name:scope+' settings',exact:true});

 await go('#/');
 const guide=owner.getByRole('dialog',{name:'Welcome to Boardly',exact:true});
 await guide.getByRole('button',{name:'View desktop downloads',exact:true}).waitFor();
 await owner.route('**/api/onboarding',route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Setup save unavailable'})}):route.continue(),{times:1});
 await guide.getByRole('button',{name:'View desktop downloads',exact:true}).click();
 await guide.getByRole('alert').getByText('Setup save unavailable',{exact:true}).waitFor();
 assert.ok(!owner.url().endsWith('#/settings/apps'));
 await guide.getByRole('button',{name:'View desktop downloads',exact:true}).click();
 const downloads=owner.getByRole('region',{name:'Desktop downloads',exact:true});
 await downloads.waitFor();
 assert.ok(owner.url().endsWith('#/settings/apps'),'download navigation reaches Apps & devices');
 assert.equal((await f.api('/api/onboarding')).status,'skipped');
 await owner.reload();await downloads.waitFor();assert.equal(await guide.count(),0);
 const expected={
  'Download Windows installer':'Boardly.Setup.1.9.0.exe',
  'Download legacy Mac DMG':'Boardly-1.9.0-arm64.dmg',
  'Download Linux AppImage':'Boardly-1.9.0.AppImage',
  'Download Linux DEB':'boardly_1.9.0_amd64.deb'
 };
 await downloads.getByLabel('Desktop platform',{exact:true}).selectOption('');
 for(const [label,file] of Object.entries(expected))assert.equal(await downloads.getByRole('link',{name:label,exact:true}).getAttribute('href'),'https://github.com/bensblueprints/boardly-kanban-mvp/releases/download/v1.9.0/'+file);
 await downloads.getByText(/failed strict code-signature verification/).waitFor();
 await downloads.getByText(/Customer desktop account linking and cloud sync are not available yet/).waitFor();
 assert.equal(await downloads.getByRole('link',{name:'Open Boardly on the web',exact:true}).getAttribute('href'),'https://boardlyagent.com/app');
 for(const [platform,count] of [['Windows',1],['Mac',1],['Linux',2],['',4]]){await downloads.getByLabel('Desktop platform',{exact:true}).selectOption(platform);assert.equal(await downloads.getByRole('article').count(),count);}
 await downloads.getByRole('button',{name:'Open owner desktop sync setup',exact:true}).click();
 await owner.getByRole('textbox',{name:'Sync server URL',exact:true}).waitFor();
 await owner.getByRole('button',{name:'Download apps',exact:true}).click();
 for(const size of [{width:320,height:568},{width:390,height:844},{width:1440,height:1000}]){
  await owner.setViewportSize(size);await downloads.getByLabel('Desktop platform',{exact:true}).selectOption('');
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page fits '+size.width);
  assert.ok(await downloads.evaluate(e=>e.scrollWidth<=e.clientWidth),'downloads fit '+size.width);
 }
 await owner.getByRole('button',{name:'Back to workspace',exact:true}).click();
 await owner.getByRole('link',{name:'Download desktop apps',exact:true}).focus();await owner.keyboard.press('Enter');await downloads.waitFor();
 await member.goto(url+'?user='+user+'#/settings/apps');
 await member.getByRole('button',{name:'Set up later',exact:true}).click();
 const memberDownloads=member.getByRole('region',{name:'Desktop downloads',exact:true});await memberDownloads.waitFor();
 assert.equal(await memberDownloads.getByRole('button',{name:'Open owner desktop sync setup',exact:true}).count(),0);
 assert.equal(await member.getByRole('button',{name:'Desktop sync',exact:true}).count(),0);
 await memberDownloads.getByLabel('Desktop platform',{exact:true}).selectOption('');assert.equal(await memberDownloads.getByRole('article').count(),4);
 assert.equal((await f.request('/api/sync/status',{user,workspace:'user_owner'})).status,403);
 await member.setViewportSize({width:320,height:568});assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'member mobile layout');
 assert.deepEqual(errors,[]);
 console.log('PASS: download onboarding, failed-save recovery, persistence, exact installer URLs, platform filters, signing/sync guidance, owner setup, member restrictions, keyboard navigation and responsive layouts');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
