const assert = require('node:assert/strict'), path = require('node:path');
const { fixture } = require('./member-fixture');
const { chromium } = require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
(async () => {
  const f = await fixture(); let browser, vite;
  try {
    const a = await f.project('Chat QA', 'Concurrent project');
    const store = require('../server/connections').createConnections(f.root);
    const key = store.issue('user_owner', 'Cloud agent QA', 'worker'); store.close();
    const worker = async (route, body = {}) => {
      const response = await fetch(f.base + route, { method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    const enqueue = async title => {
      const thread = await f.api(`/api/boards/${a.project.id}/chat/threads`, { method: 'POST', body: { title } });
      const job = await f.api(`/api/chat/threads/${thread.id}/messages`, { method: 'POST', body: { content: title, mode: 'work' } });
      return { thread, job };
    };
    const work = await enqueue('First assignment');
    assert.equal((await worker('/api/worker/claim')).job.id, work.job.id);
    const waiting = await enqueue('Second assignment');
    const { createServer } = await import('vite'), react = (await import('@vitejs/plugin-react')).default, tailwind = (await import('@tailwindcss/vite')).default;
    vite = await createServer({ configFile: false, root: path.resolve('client'), plugins: [react(), tailwind(), {
      name: 'chat-qa', resolveId(id) { if (id === '/qa-entry.jsx') return '\0chat-qa'; },
      load(id) { if (id === '\0chat-qa') return `import React from 'react';import{createRoot}from'react-dom/client';import{Workspace}from'/src/App.jsx';import{setTokenProvider}from'/src/api.js';import'/src/index.css';setTokenProvider(async()=>${JSON.stringify(f.token('user_owner'))});createRoot(document.getElementById('root')).render(React.createElement(Workspace,{cloud:true,onLogout:()=>{}}));`; },
      configureServer(s) { s.middlewares.use('/qa', async (q, r) => { r.setHeader('content-type', 'text/html'); r.end(await s.transformIndexHtml('/qa', '<html><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>')); }); }
    }], server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: f.base, configure: p => p.on('proxyReq', q => q.setHeader('origin', f.config.origin)) } } } });
    await vite.listen();
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(vite.resolvedUrls.local[0] + `qa#/board/${a.project.id}`);
    await page.getByRole('button', { name: 'Chat with AI', exact: true }).click();
    const chat = page.getByRole('dialog', { name: 'Codex chat for Concurrent project' });
    await chat.getByText('Waiting for this project’s Work chat', { exact: false }).waitFor();
    await chat.getByText('Another Work conversation is changing this project.', { exact: false }).waitFor();
    assert.ok((await chat.getByLabel('Conversation history').textContent()).includes('First assignment · Work running'));
    await chat.getByRole('button', { name: 'Work', exact: true }).click();
    await chat.getByLabel('Message Codex').fill('Explain progress while work continues');
    await chat.getByRole('button', { name: 'Ask in a new chat', exact: true }).click();
    assert.equal(await chat.getByRole('button', { name: 'Ask', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await chat.getByLabel('Message Codex').inputValue(), 'Explain progress while work continues');
    assert.equal((await f.api(`/api/chat/threads/${waiting.thread.id}`)).job.status, 'queued');
    const posted = page.waitForResponse(response => response.url().includes('/api/chat/threads/') && response.url().endsWith('/messages') && response.request().method() === 'POST');
    await chat.getByRole('button', { name: 'Ask AI', exact: true }).click();
    assert.equal((await posted).status(), 202);
    await chat.getByText('Explain progress while work continues', { exact: true }).waitFor();
    const ask = (await worker('/api/worker/claim')).job;
    assert.equal(ask.mode, 'ask'); assert.equal(ask.board_id, a.project.id);
    assert.equal((await f.api(`/api/chat/threads/${work.thread.id}`)).job.status, 'running');
    await chat.getByRole('button', { name: 'Stop', exact: true }).click();
    await worker(`/api/worker/jobs/${ask.id}`, { status: 'cancelled' });
    assert.equal((await f.api(`/api/chat/threads/${work.thread.id}`)).job.status, 'running');
    await worker(`/api/worker/jobs/${work.job.id}`, { status: 'completed', text: 'First complete' });
    assert.equal((await worker('/api/worker/claim')).job.id, waiting.job.id);
    await chat.getByLabel('Conversation history').selectOption(waiting.thread.id);
    await chat.getByText('This conversation is running.', { exact: false }).waitFor();
    await chat.getByRole('button', { name: 'Maximize chat window', exact: true }).click();
    await page.screenshot({ path: '/home/ben/.local/share/boardly-ops/chat-concurrency-desktop-20260909.png' });
    await page.setViewportSize({ width: 320, height: 740 });
    await chat.getByRole('button', { name: 'Start new conversation', exact: true }).click();
    assert.equal(await chat.getByRole('button', { name: 'Ask', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    await page.screenshot({ path: '/home/ben/.local/share/boardly-ops/chat-concurrency-mobile-20260909.png' });
    await worker(`/api/worker/jobs/${waiting.job.id}`, { status: 'completed', text: 'Second complete' });
    assert.deepEqual(errors, []);
    console.log('PASS: visible queue reason, live history, new Ask with draft intact, concurrent Work, independent cancellation, desktop/mobile and maximize');
  } finally { if (browser) await browser.close(); if (vite) await vite.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
