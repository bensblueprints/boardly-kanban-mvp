const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./member-fixture');
const {chromium}=require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f,vite,browser,owner,member;
(async()=>{
 f=await fixture();const a=await f.project('Clothing Company','Nasdo');
 const added=await f.api(`/api/companies/${a.company.id}/members`,{method:'POST',body:{email:'member@example.com',role:'editor'}}),user=added.member.user_id;
 const projectAdded=await f.api(`/api/projects/${a.project.id}/members`,{method:'POST',body:{email:'project@example.com',role:'editor'}});
 const tokens=Object.fromEntries(['user_owner',user,projectAdded.member.user_id].map(id=>[id,f.token(id)]));
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{
  name:'scope-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0scope-qa';},load(id){if(id==='\0scope-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const user=new URLSearchParams(location.search).get('user')||'user_owner',tokens=${JSON.stringify(tokens)},getToken=async()=>tokens[user];createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:user,getToken,onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();const url=vite.resolvedUrls.local[0]+'qa';
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const errors=[];
 owner=await browser.newPage({viewport:{width:1440,height:1000}});member=await browser.newPage({viewport:{width:1280,height:1000}});
 for(const page of [owner,member])page.on('pageerror',error=>errors.push(error.message));
 await owner.goto(url+`#/company/${a.company.id}`);await owner.getByRole('button',{name:'Members',exact:true}).click();
 const row=owner.getByRole('region',{name:'member@example.com',exact:true}),projectRow=owner.getByRole('region',{name:'project@example.com · Nasdo',exact:true});
 await row.getByRole('button',{name:'Permission scopes',exact:true}).click();
 assert.equal(await row.getByRole('checkbox').count(),5);for(const box of await row.getByRole('checkbox').all())assert.equal(await box.isChecked(),false);
 await projectRow.getByRole('button',{name:'Permission scopes',exact:true}).click();assert.equal(await projectRow.getByRole('checkbox').count(),5);
 await member.goto(url+`?user=${user}#/board/${a.project.id}`);await member.getByLabel('Project name',{exact:true}).waitFor();
 for(const name of ['SSH','GitHub','Environment','Payments','Members'])assert.equal(await member.getByRole('button',{name,exact:true}).count(),0);
 async function toggle(name,on=true,target=row){const box=target.getByRole('checkbox',{name:new RegExp('^'+name+' permission')});await box.setChecked(on);await box.isChecked().then(value=>assert.equal(value,on));await owner.waitForFunction(()=>![...document.querySelectorAll('fieldset')].some(element=>element.disabled));}
 await toggle('Environment');await member.getByRole('button',{name:'Environment',exact:true}).waitFor({timeout:6500});
 await member.getByRole('button',{name:'Environment',exact:true}).click();await member.getByLabel('Variable name',{exact:true}).waitFor();
 await toggle('Environment',false);await member.getByRole('navigation',{name:'Project tools'}).getByRole('button',{name:'Environment',exact:true}).waitFor({state:'detached',timeout:6500});
 assert.equal(await member.getByLabel('Variable name',{exact:true}).count(),0,'Revocation closes the secret settings panel');
 for(const name of ['SSH','GitHub','Payment connections','Members'])await toggle(name);
 await member.getByRole('button',{name:'Payments',exact:true}).waitFor({timeout:6500});await member.getByRole('button',{name:'Payments',exact:true}).click();
 await member.getByRole('button',{name:'Add payment card',exact:true}).waitFor();assert.equal(await member.getByRole('button',{name:'Save spending settings',exact:true}).count(),0);
 await member.getByLabel('Close project files and links').click();await member.getByRole('button',{name:'Members',exact:true}).click();
 await member.getByRole('dialog',{name:'Members',exact:true}).waitFor();assert.equal(await member.getByRole('button',{name:'Permission scopes',exact:true}).count(),0);
 assert.equal(await member.getByRole('region',{name:'member@example.com',exact:true}).getByRole('button',{name:'Remove',exact:true}).count(),0);
 await member.getByLabel('Close members').click();
 await member.goto(url+`?user=${user}#/company/${a.company.id}`);await member.getByRole('button',{name:'SSH',exact:true}).waitFor();await member.getByRole('button',{name:'GitHub',exact:true}).waitFor();
 await toggle('Environment',true);await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/member-scopes-owner.png'});
 await owner.setViewportSize({width:390,height:844});await owner.screenshot({path:'/home/ben/.local/share/boardly-ops/member-scopes-mobile.png'});
 assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No horizontal page overflow on mobile');
 // Existing project-only members can receive scopes here without company access.
 await toggle('GitHub',true,projectRow);
 const guest=await browser.newPage();guest.on('pageerror',error=>errors.push(error.message));await guest.goto(url+`?user=${projectAdded.member.user_id}#/board/${a.project.id}`);await guest.getByRole('button',{name:'GitHub',exact:true}).waitFor();assert.equal(await guest.getByRole('button',{name:'SSH',exact:true}).count(),0);
 await guest.getByRole('button',{name:'GitHub',exact:true}).click();await guest.getByRole('button',{name:'Connect GitHub',exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: company owner toggles all scopes, project-member scopes, live grant/revocation UI, delegated member controls, payment restrictions, project tools and mobile layout');
})().catch(async error=>{console.error(error);if(member)console.error((await member.locator('body').innerText()).slice(0,2200));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(vite)await vite.close();if(f)await f.close();});
