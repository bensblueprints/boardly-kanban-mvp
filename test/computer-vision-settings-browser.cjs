const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.BOARDLY_PLAYWRIGHT_MODULE||'playwright');
let vite,browser;
(async()=>{
 const repo=path.resolve(__dirname,'..'),{createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default,tailwind=(await import('@tailwindcss/vite')).default;
 vite=await createServer({configFile:false,root:repo+'/client',plugins:[react(),tailwind(),{name:'vision-qa',resolveId(id){if(id==='/qa-entry.jsx')return '\0vision-qa';},load(id){if(id==='\0vision-qa')return "import React from 'react';import {createRoot} from 'react-dom/client';import ComputerVisionSettings from '/src/components/ComputerVisionSettings.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(ComputerVisionSettings));";},configureServer(s){s.middlewares.use('/qa',async(q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/qa','<html class="dark"><body class="bg-zinc-950 text-zinc-100 p-6"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>'));});}}],server:{host:'127.0.0.1',port:0}});await vite.listen();
 browser=await chromium.launch({executablePath:process.env.BOARDLY_CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const p=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const state={mode:'gpt',connection_id:null,connections:[{id:'gpu-one',label:'My private RTX GPU',allow_agent:true,has_fingerprint:true,tested:false}]};let installs=0,tests=0,saves=0;
 await p.route('**/api/account/computeruse/vision**',async route=>{const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();let result=state;
  if(url.pathname.endsWith('/install-status'))result={status:'installed',message:'Qwen is installed. Test your GPU.'};
  else if(url.pathname.endsWith('/install')){installs++;assert.equal(body.connection_id,'gpu-one');result={status:'installing',message:'Downloading verified model files.'};}
  else if(url.pathname.endsWith('/test')){tests++;state.connections[0].tested=true;result={...state,ready:true,elapsed_ms:1200};}
  else if(req.method()==='PUT'){saves++;state.mode=body.mode;state.connection_id=body.connection_id;}
  await route.fulfill({json:result});
 });
 await p.goto(vite.resolvedUrls.local[0]+'qa');await p.getByText('Active: GPT only',{exact:true}).waitFor();await p.getByLabel('Vision mode',{exact:true}).selectOption('local');
 await p.getByLabel('My GPU computer',{exact:true}).selectOption('gpu-one');assert.equal(await p.getByRole('button',{name:'Save vision mode',exact:true}).isEnabled(),false);
 await p.getByRole('button',{name:'Install Qwen · about 6 GB',exact:true}).click();await p.getByText('Qwen is installed. Test your GPU.',{exact:true}).waitFor();
 await p.getByRole('button',{name:'Test GPU',exact:true}).click();await p.getByText(/GPU passed the screen-reading test/).waitFor();await p.getByRole('button',{name:'Save vision mode',exact:true}).click();await p.getByText('Active: GPT + my GPU',{exact:true}).waitFor();
 if(process.env.BOARDLY_VISION_SCREENSHOT)await p.screenshot({path:process.env.BOARDLY_VISION_SCREENSHOT,fullPage:true});
 await p.reload();await p.getByText('Active: GPT + my GPU',{exact:true}).waitFor();assert.equal(await p.getByLabel('My GPU computer',{exact:true}).inputValue(),'gpu-one');
 await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await p.getByLabel('Vision mode',{exact:true}).selectOption('gpt');await p.getByRole('button',{name:'Save vision mode',exact:true}).click();await p.getByText('Active: GPT only',{exact:true}).waitFor();
 assert.equal(installs,1);assert.equal(tests,1);assert.equal(saves,2);assert.deepEqual(errors,[]);console.log('PASS: GPU selection, install progress, inference test before enablement, saved mode after reload, GPT-only switch and mobile layout');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await vite?.close();});
