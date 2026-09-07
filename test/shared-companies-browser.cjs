const assert = require('node:assert/strict'), path = require('node:path');
const { fixture } = require('./member-fixture');
const { chromium } = require('/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
let f, vite, browser, page;
(async () => {
  f = await fixture({ publicAccess: true });
  const shared = await f.project('Clothing Company', 'Nasdo');
  const second = await f.project('Second shared company', 'Second project');
  await f.project('Private company', 'Private project');
  f.users.push({ id: 'user_existing', emailAddresses: [{ emailAddress: 'existing@example.com', verification: { status: 'verified' } }] });
  await f.project('Personal company', 'Personal project', 'user_existing');
  const repo = path.resolve(__dirname, '..'), { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default, tailwind = (await import('@tailwindcss/vite')).default;
  vite = await createServer({ configFile: false, root: repo + '/client', plugins: [react(), tailwind(), {
    name: 'shared-company-qa',
    resolveId(id) { if (id === '/qa-entry.jsx') return '\0shared-company-qa'; },
    load(id) { if (id === '\0shared-company-qa') return `import React from 'react';import {createRoot} from 'react-dom/client';import WorkspaceSession from '/src/WorkspaceSession.jsx';import '/src/index.css';const getToken=async()=>${JSON.stringify(f.token('user_existing'))};createRoot(document.getElementById('root')).render(React.createElement(WorkspaceSession,{userId:'user_existing',getToken,onLogout:()=>{}}));`; },
    configureServer(server) { server.middlewares.use('/qa', async (req, res) => { res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/qa', '<html class="dark"><body class="bg-zinc-950 text-zinc-100"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>')); }); },
  }], server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: f.base, configure: proxy => proxy.on('proxyReq', req => req.setHeader('origin', f.config.origin)) } } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:',error.message); });
  await page.goto(vite.resolvedUrls.local[0] + 'qa');
  await page.getByRole('button', { name: /^Personal company/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Clothing Company/ }).count(), 0);
  const addedAt = Date.now();
  await f.api(`/api/companies/${shared.company.id}/members`, { method: 'POST', body: { email: 'existing@example.com', role: 'editor' } });
  await page.getByRole('button', { name: /Clothing Company/ }).waitFor({ timeout: 6500 });
  assert.ok(Date.now() - addedAt < 6500, 'Grant appears without reload or account switching');
  assert.equal(await page.getByRole('button', { name: /Private company/ }).count(), 0);
  await page.screenshot({ path: '/home/ben/.local/share/boardly-ops/shared-companies-visible.png' });
  await page.getByRole('button', { name: /Clothing Company/ }).click();
  await page.getByRole('heading', { name: 'Clothing Company', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Workspace account').inputValue(), 'user_owner');
  await page.reload();
  await page.getByRole('heading', { name: 'Clothing Company', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Workspace account').inputValue(), 'user_owner', 'Selection survives reload');
  await page.getByRole('button', { name: 'Companies', exact: true }).click();
  // A new grant inside the current sponsoring workspace also refreshes the tree.
  await f.api(`/api/companies/${second.company.id}/members`, { method: 'POST', body: { email: 'existing@example.com', role: 'viewer' } });
  await page.getByRole('button', { name: /Second shared company/ }).waitFor({ timeout: 6500 });
  await page.getByRole('button', { name: /Clothing Company/ }).click();
  const direct = await f.api(`/api/companies/${shared.company.id}/members`);
  await f.api(`/api/memberships/${direct.members[0].grant_id}`, { method: 'DELETE' });
  await page.getByRole('heading', { name: 'Clothing Company', exact: true }).waitFor({ state: 'detached', timeout: 6500 });
  const last = await f.api(`/api/companies/${second.company.id}/members`);
  await f.api(`/api/memberships/${last.members[0].grant_id}`, { method: 'DELETE' });
  await page.getByRole('button', { name: /^Personal company/ }).waitFor({ timeout: 6500 });
  assert.equal(new URL(page.url()).hash, '#/', 'Revocation clears a route whose numeric ID belongs to another workspace');
  assert.equal(await page.getByRole('button', { name: /Clothing Company/ }).count(), 0);
  // Direct project guests get the company navigation too.
  await f.api(`/api/projects/${shared.project.id}/members`, { method: 'POST', body: { email: 'existing@example.com', role: 'editor' } });
  await page.getByRole('button', { name: /Clothing Company/ }).waitFor({ timeout: 6500 });
  await page.getByRole('button', { name: /Clothing Company/ }).click();
  await page.getByRole('heading', { name: 'Clothing Company', exact: true }).waitFor();
  await page.getByRole('button', { name: /Board.*1 projects/ }).click();
  await page.getByRole('button', { name: /Nasdo/ }).click();
  await page.getByLabel('Project name', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Nasdo');
  assert.deepEqual(errors, []);
  console.log('PASS: real session UI discovers grants without reload, switches to company, persists account, refreshes current tree, handles revocation and opens project guest access');
})().catch(async error => { console.error(error); if(page){console.error((await page.locator('body').innerText()).slice(0,2500));await page.screenshot({path:'/home/ben/.local/share/boardly-ops/shared-companies-failure.png'});} process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); if (vite) await vite.close(); if (f) await f.close(); });
