const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {viewerFixture}=require('./computer-viewer-fixture');
const {chromium}=require(process.env.BOARDLY_PLAYWRIGHT_MODULE||'playwright');
let v,vite,browser,page;const directTest=process.env.BOARDLY_TEST_DIRECT==='1';
async function assertFitted(dialog){
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await page.waitForFunction(()=>{const c=document.querySelector('[aria-label="Live remote desktop"]');return c&&c.getBoundingClientRect().height>0;});
 const layout=await dialog.evaluate(d=>{const c=d.querySelector('canvas'),r=c.getBoundingClientRect(),ancestors=[];for(let el=c.parentElement;el;el=el.parentElement){ancestors.push({name:el.className,overflowY:el.scrollHeight-el.clientHeight,overflowX:el.scrollWidth-el.clientWidth});if(el===d)break;}return{width:r.width,height:r.height,ratio:c.width/c.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,ancestors};});
 const size=page.viewportSize();assert.ok(layout.left>=0&&layout.top>=0&&layout.right<=size.width+1&&layout.bottom<=size.height+1,JSON.stringify(layout));
 assert.ok(Math.abs(layout.width/layout.height-layout.ratio)<0.01,'Desktop must retain its aspect ratio');
 assert.ok(layout.ancestors.every(a=>a.overflowY<=1&&a.overflowX<=1),'Viewer must fit without scrolling: '+JSON.stringify(layout.ancestors));
}
(async()=>{
 v=await viewerFixture({direct:directTest});const {f,p}=v,token=f.token('user_owner');
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{name:'viewer-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0viewer-qa';},load(id){if(id==='\0viewer-qa')return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:'user_owner',getToken:async()=>${JSON.stringify(token)},onLogout:()=>{}}));`;},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}}],server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.base,configure:p=>p.on('proxyReq',q=>q.setHeader('origin',f.config.origin))}}}});await vite.listen();
 browser=await chromium.launch({executablePath:process.env.BOARDLY_CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(directTest)await require('./rtc-browser-fixture.cjs')(page);
 await page.goto(vite.resolvedUrls.local[0]+'qa#/board/'+p.project.id);
 await page.getByRole('button',{name:'Set up later',exact:true}).click();
 const frame=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1280;c.height=800;const x=c.getContext('2d');x.fillStyle='#172554';x.fillRect(0,0,1280,800);x.fillStyle='#fff';x.font='32px sans-serif';x.fillText('Permit portal — synthetic test desktop',60,90);x.fillStyle='#dbeafe';x.fillRect(60,140,1160,590);x.fillStyle='#1e3a8a';x.font='24px sans-serif';x.fillText('Account details',100,200);return c.toDataURL('image/jpeg');});v.setFrame(frame);await page.evaluate(value=>window.__rtcFrame=value,frame);
 const {job}=await v.start();const dialog=page.getByRole('dialog',{name:'Live computer window',exact:true});await dialog.waitFor();await dialog.getByText('Agent has control',{exact:true}).waitFor();await dialog.getByLabel('Computer connection').filter({hasText:/[0-9]+ ms/}).waitFor();
 if(directTest){await dialog.getByLabel('Computer connection').filter({hasText:/Direct connection/}).waitFor();assert.equal(await page.evaluate(()=>window.__rtcConnections.at(-1).readOnly),true);}
 await dialog.getByRole('button',{name:'Maximize computer window',exact:true}).click();assert.equal(await dialog.evaluate(el=>Math.round(el.getBoundingClientRect().width)),1440);
 await assertFitted(dialog);
 await dialog.getByRole('button',{name:'Restore computer window',exact:true}).click();assert.ok((await dialog.boundingBox()).width<1440);
 await assertFitted(dialog);
 await dialog.getByRole('button',{name:'Take Over',exact:true}).click();await dialog.getByText('You have control · agent paused',{exact:true}).waitFor();await dialog.getByLabel('Computer connection').filter({hasText:/[0-9]+ ms/}).waitFor();assert.equal(v.getMode(),'human');
 if(directTest)await dialog.getByLabel('Computer connection').filter({hasText:/Direct connection/}).waitFor();
 await dialog.getByLabel('Text to type on computer').fill('A user-entered test value');await dialog.getByRole('button',{name:'Type',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Text to type on computer"]').value==='');
 await page.waitForTimeout(100);if(directTest){const inputs=await page.evaluate(()=>window.__rtcInputs);assert.equal(inputs.length,1);assert.equal(inputs[0].action.text,'A user-entered test value');assert.equal(v.inputs.size,0,'Direct inputs must bypass the server relay');}else{assert.equal(v.inputs.size,1);assert.equal([...v.inputs.values()][0].text,'A user-entered test value');}
 if(directTest){await page.evaluate(()=>window.__rtcDropInput=true);await dialog.getByLabel('Text to type on computer').fill('uncertain once');await dialog.getByRole('button',{name:'Type',exact:true}).click();await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>window.__rtcInputs.length),2);assert.equal(v.inputs.size,0,'A lost direct acknowledgement must not replay through HTTP');await dialog.getByLabel('Computer connection').filter({hasText:/Server connection/}).waitFor();}
 await dialog.getByRole('button',{name:'Close computer window',exact:true}).click();assert.equal(v.getMode(),'human');await page.waitForTimeout(2400);assert.equal(await dialog.isVisible(),false,'Dismissal must stick across activity polling');
 await page.getByRole('button',{name:'Open computer',exact:true}).click();await dialog.getByText('You have control · agent paused',{exact:true}).waitFor();
 await v.workerApi(`/api/worker/jobs/${job.id}`,{status:'blocked',blocker:'Awaiting human signup',next_action:'Give back after signup',text:'Signup ready'});
 await dialog.getByRole('button',{name:'Give Back to Agent',exact:true}).click();await dialog.getByText('Control returned. Your agent is resuming the saved work.',{exact:true}).waitFor();assert.equal(v.getMode(),'agent');
 const history=await f.api('/api/chat/threads/'+(await f.api(`/api/boards/${p.project.id}/chat/threads`))[0].id);assert.equal(history.job.status,'queued');assert.equal(history.job.id,job.id);
 await dialog.getByLabel('Computer connection').filter({hasText:/[0-9]+ ms/}).waitFor();await page.screenshot({path:'/tmp/boardly-live-computer-desktop.png'});
 await page.setViewportSize({width:390,height:844});assert.ok((await dialog.boundingBox()).width<=390);assert.ok((await dialog.boundingBox()).height<=844);
 await dialog.getByRole('button',{name:'Take Over',exact:true}).click();await dialog.getByLabel('Text to type on computer').waitFor();await page.screenshot({path:'/tmp/boardly-live-computer-mobile.png'});
 await assertFitted(dialog);
 assert.ok(await dialog.getByRole('button',{name:'Give Back to Agent',exact:true}).isVisible());
 await dialog.getByRole('button',{name:'Maximize computer window',exact:true}).click();assert.equal(Math.round((await dialog.boundingBox()).height),844);
 for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1280,height:720},{width:1920,height:1080}]){await page.setViewportSize(viewport);await assertFitted(dialog);}
 await page.setViewportSize({width:1280,height:720});await assertFitted(dialog);await page.screenshot({path:'/tmp/boardly-live-computer-maximized.png'});
 await dialog.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click();await dialog.getByRole('button',{name:'Address bar',exact:true}).waitFor();await assertFitted(dialog);
 await dialog.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click();
 const portrait=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=800;c.height=1200;const x=c.getContext('2d');x.fillStyle='#172554';x.fillRect(0,0,800,1200);return c.toDataURL('image/jpeg');});v.setFrame(portrait);await page.evaluate(value=>window.__rtcFrame=value,portrait);
 await page.waitForFunction(()=>document.querySelector('[aria-label="Live remote desktop"]').height===1200);await assertFitted(dialog);
 const priorDirect=directTest?await page.evaluate(()=>window.__rtcInputs.length):0,priorInputs=v.inputs.size+priorDirect,screen=dialog.getByLabel('Live remote desktop'),box=await screen.boundingBox();
 await screen.click({position:{x:box.width/4,y:box.height*3/4}});
 await page.waitForTimeout(200);
 const remoteInputs=directTest?await page.evaluate(()=>window.__rtcInputs):[];
 assert.equal(v.inputs.size+remoteInputs.length,priorInputs+1,'Scaled pointer input must be sent exactly once');
 const pointer=remoteInputs.length>priorDirect?remoteInputs.at(-1).action:[...v.inputs.values()].at(-1);
 assert.equal(pointer.type,'click');assert.ok(Math.abs(pointer.x-200)<=2&&Math.abs(pointer.y-900)<=2,'Pointer must map to desktop pixels, excluding letterbox bars: '+JSON.stringify(pointer));
 await dialog.getByRole('button',{name:'Minimize computer window',exact:true}).click();assert.equal(v.getMode(),'human');await page.waitForTimeout(2200);assert.equal(await dialog.isVisible(),false);
 await page.getByRole('button',{name:'Open computer',exact:true}).click();await dialog.getByText('You have control · agent paused',{exact:true}).waitFor();await assertFitted(dialog);
 await dialog.getByRole('button',{name:'Close computer window',exact:true}).click();await page.reload();await page.waitForTimeout(2500);assert.equal(await dialog.isVisible(),false,'Reload must not reopen a dismissed run');
 assert.equal(v.getMode(),'human');assert.deepEqual(errors,[]);
 console.log((directTest?'DIRECT (simulated RTC): ':'FALLBACK: ')+'PASS: viewport fit without scrolling, aspect ratio and resolution changes, scaled pointer input, keyboard shortcuts, maximize/restore, takeover, typed input once, minimize/reopen preserving control, handback recovery, desktop/mobile/landscape layouts');
})().catch(async e=>{console.error(e);if(page)console.error((await page.locator('body').innerText()).slice(-1800));process.exitCode=1;}).finally(async()=>{await browser?.close();await vite?.close();await v?.f.close();});
