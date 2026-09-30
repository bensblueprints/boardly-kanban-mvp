const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./member-fixture');
const { chromium } = require(process.env.BOARDLY_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const key = 'deepseek-browser-fixture-key';
  const modelRequests = [],pingRequests=[];let pingFails=false;
  const f = await fixture({providerConnectorRequest: async (url, options) => {
    if(url.endsWith('/chat/completions')){const body=JSON.parse(options.body);pingRequests.push(body);if(pingFails)return Response.json({error:{message:'offline'}},{status:503});return Response.json({choices:[{message:{content:'OK'}}]});}
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    assert.ok(options.headers.Authorization.startsWith('Bearer '));
    modelRequests.push(url);
    return Response.json({data: [{id: 'deepseek-fixture-fast'}, {id: 'deepseek-fixture-reasoning'}]});
  }});
  let vite, browser;
  try {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    const tailwind = (await import('@tailwindcss/vite')).default;
    vite = await createServer({configFile: false, root: path.resolve('client'), plugins: [react(), tailwind(), {
      name: 'deepseek-fixture',
      resolveId(id) { if (id === '/deepseek-fixture.jsx') return '\0deepseek-fixture'; },
      load(id) {
        if (id === '\0deepseek-fixture') return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:'user_owner',getToken:async()=>${JSON.stringify(f.token('user_owner'))},profile:{name:'Test Owner',email:'owner@example.com'}}));`;
      },
      configureServer(server) {
        server.middlewares.use('/qa', async (req, res) => {
          res.setHeader('content-type', 'text/html');
          res.end(await server.transformIndexHtml('/qa', '<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/deepseek-fixture.jsx"></script></body></html>'));
        });
      }
    }], server: {host: '127.0.0.1', port: 0, proxy: {'/api': {target: f.base, configure: p => p.on('proxyReq', q => q.setHeader('origin', f.config.origin))}}}});
    await vite.listen();
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = vite.resolvedUrls.local[0] + 'qa';
    const p=await f.project('Browser Company','Browser Board');
    await page.goto(url + `#/company/${p.company.id}/settings/connectors`);
    const later=page.getByRole('button',{name:'Set up later',exact:true});await later.waitFor();await later.click();
    await page.getByLabel('Inherit Organization AI',{exact:true}).waitFor();
    await page.getByLabel('Use a company connection',{exact:true}).check();
    const input=page.getByLabel('DeepSeek API key',{exact:true});await input.fill(key);
    await page.getByRole('button',{name:'Verify connection',exact:true}).click();
    await page.getByText('Connection verified. Select a model above and save company AI.',{exact:true}).waitFor();
    await page.getByLabel('Company AI model',{exact:true}).selectOption('deepseek-fixture-reasoning');
    await page.getByRole('button',{name:'Test model',exact:true}).click();
    await page.getByText('Model is online and responding',{exact:false}).waitFor();
    assert.equal(pingRequests.at(-1).model,'deepseek-fixture-reasoning');
    assert.equal((await f.api(`/api/companies/${p.company.id}/ai`)).policy.source,'inherit','Test does not save the selected default');
    await page.getByLabel('Company AI model',{exact:true}).selectOption('deepseek-fixture-fast');
    await page.getByText('Model is online and responding',{exact:false}).waitFor({state:'hidden'});
    pingFails=true;await page.getByRole('button',{name:'Test model',exact:true}).click();
    await page.getByText('Model test failed',{exact:false}).waitFor();pingFails=false;
    await page.getByLabel('Company AI model',{exact:true}).selectOption('deepseek-fixture-reasoning');
    await page.getByRole('button',{name:'Test model',exact:true}).click();await page.getByText('Model is online and responding',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Save company AI',exact:true}).click();
    await page.getByText('Company AI saved. New requests and delegated work use this selection.',{exact:true}).waitFor();
    assert.equal((await f.api(`/api/companies/${p.company.id}/ai`)).effective.model,'deepseek-fixture-reasoning');
    assert.equal((await f.api('/api/ai/settings')).mode,'none');
    await page.reload();await page.getByLabel('Company AI model',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Company AI model',{exact:true}).inputValue(),'deepseek-fixture-reasoning');
    assert.equal(await input.inputValue(),'');
    await page.screenshot({path:require('node:os').tmpdir()+'/boardly-company-ai.png',fullPage:true});
    await page.getByLabel('Inherit Organization AI',{exact:true}).check();await page.getByRole('button',{name:'Save company AI',exact:true}).click();
    await page.getByText('Company AI saved. New requests and delegated work use this selection.',{exact:true}).waitFor();
    assert.equal((await f.api(`/api/companies/${p.company.id}/ai`)).policy.source,'inherit');
    await page.goto(url + `#/company/${p.company.id}`);
    await page.getByRole('button',{name:'Departments',exact:true}).waitFor();
    await page.getByRole('button',{name:'New department',exact:true}).click();
    await page.getByPlaceholder('Department name',{exact:true}).fill('QA Department');
    await page.getByRole('button',{name:'Create department',exact:true}).click();
    await page.getByRole('button',{name:'QA Department 0 boards',exact:true}).click();
    await page.getByRole('button',{name:'New board',exact:true}).waitFor();
    await page.getByRole('button',{name:'Department settings',exact:true}).click();
    await page.getByLabel('Inherit Company AI',{exact:true}).waitFor();
    await page.getByLabel('Use a company connection',{exact:true}).check();
    await page.getByLabel('Department AI model',{exact:true}).selectOption('deepseek-fixture-fast');
    await page.getByRole('button',{name:'Test model',exact:true}).click();
    await page.getByText('Model is online and responding',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Save department AI',exact:true}).click();
    await page.getByText('Department AI saved. New requests and delegated work use this selection.',{exact:true}).waitFor();
    await page.reload();await page.getByLabel('Department AI model',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Department AI model',{exact:true}).inputValue(),'deepseek-fixture-fast');
    await page.goto(url + `#/board/${p.project.id}/settings/connectors`);
    await page.getByLabel('Inherit Department AI',{exact:true}).waitFor();
    await page.getByLabel('Use a company connection',{exact:true}).check();
    await page.getByLabel('Board AI model',{exact:true}).selectOption('deepseek-fixture-reasoning');
    await page.getByRole('button',{name:'Test model',exact:true}).click();await page.getByText('Model is online and responding',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Save board AI',exact:true}).click();
    await page.getByText('Board AI saved. New requests and delegated work use this selection.',{exact:true}).waitFor();
    assert.equal((await f.api(`/api/projects/${p.project.id}/ai`)).effective.model,'deepseek-fixture-reasoning');
    await page.reload();await page.getByLabel('Board AI model',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Board AI model',{exact:true}).inputValue(),'deepseek-fixture-reasoning');
    await page.getByLabel('Inherit Department AI',{exact:true}).check();await page.getByRole('button',{name:'Save board AI',exact:true}).click();
    await page.getByText('Board AI saved. New requests and delegated work use this selection.',{exact:true}).waitFor();
    assert.equal((await f.api(`/api/projects/${p.project.id}/ai`)).policy.source,'inherit');
    await page.goto(url + '#/');
    await page.getByRole('button',{name:'Organization AI / Delegate work',exact:true}).click();
    await page.getByRole('dialog',{name:'organization AI',exact:true}).waitFor();
    await page.getByRole('button',{name:'Work Delegate Board work',exact:true}).click();
    await page.getByLabel('AI message',{exact:true}).fill('Review company work');
    assert.equal(await page.getByRole('button',{name:'Delegate work',exact:true}).isEnabled(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: Company AI selectors; model ping success/error and stale-result reset; private key entry; model discovery; save/reload; inheritance reset; Departments and Boards navigation; Organization delegation UI.');
  } finally {
    await browser?.close();
    await vite?.close();
    await f.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
