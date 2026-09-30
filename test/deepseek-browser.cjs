const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./member-fixture');
const { chromium } = require(process.env.BOARDLY_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const key = 'deepseek-browser-fixture-key';
  const modelRequests = [];
  const f = await fixture({providerConnectorRequest: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
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
    await page.goto(url + '#/settings/ai');
    const later = page.getByRole('button', {name: 'Set up later', exact: true});
    if (await later.isVisible()) await later.click();
    await page.getByRole('link', {name: /DeepSeek.*Connect DeepSeek API/}).click();
    const input = page.getByLabel('DeepSeek API key', {exact: true});
    await input.waitFor();
    assert.equal(await input.getAttribute('type'), 'password');
    await input.fill(key);
    await page.getByRole('button', {name: 'Verify connection', exact: true}).click();
    await page.getByText('Connection verified. Choose a model, then activate when ready.', {exact: true}).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal((await f.api('/api/ai/settings')).mode, 'none');
    await page.getByLabel('DeepSeek model', {exact: true}).selectOption('deepseek-fixture-reasoning');
    assert.equal(await page.getByRole('button', {name: 'Use for Boardly agents', exact: true}).isDisabled(), true);
    await page.getByRole('button', {name: 'Verify & save model', exact: true}).click();
    await page.getByRole('button', {name: 'Use for Boardly agents', exact: true}).click();
    await page.getByText('Selected for Boardly agents', {exact: true}).waitFor();
    const settings = await f.api('/api/ai/settings');
    assert.equal(settings.provider, 'deepseek');
    assert.equal(settings.model, 'deepseek-fixture-reasoning');
    await page.reload();
    await page.getByLabel('DeepSeek model', {exact: true}).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.getByLabel('DeepSeek model', {exact: true}).inputValue(), settings.model);
    await page.goto(url + '#/settings/connectors');
    const card = page.getByRole('article', {name: 'DeepSeek', exact: true});
    await card.waitFor();
    await card.getByText('Active for agents', {exact: true}).waitFor();
    assert.equal(modelRequests.length, 2, 'Only free model listing is used to verify and save');
    assert.ok(!JSON.stringify(await f.api('/api/account/ai-providers')).includes(key));
    assert.deepEqual(errors, []);
    console.log('PASS: DeepSeek appears in AI settings and connector catalog; masked key entry; fetched model selection; explicit activation; persistence after reload; no inference during verification.');
  } finally {
    await browser?.close();
    await vite?.close();
    await f.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
