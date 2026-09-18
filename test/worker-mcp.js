const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { fixture } = require('./member-fixture');
const { createWorkerMcp } = require('../scripts/worker-mcp.cjs');
(async () => {
  const f = await fixture(); let worker;
  try {
    const p = await f.project('MCP reliability', 'Reconnect assignment');
    const tokenFile = await f.mcpTokenFile(), token = fs.readFileSync(tokenFile, 'utf8');
    const settings = { origin: f.base, mcpTokenFile: tokenFile };
    let failures = 2, reads = 0; const statuses = [];
    const mcp = createWorkerMcp(settings, { wait: async () => {}, fetchImpl: async (url, options) => {
      if (options.method === 'POST') {
        const request = JSON.parse(options.body);
        assert.ok(request.method !== 'tools/call' || request.params.name === 'get_board', 'Readiness must never mutate data');
        if (failures > 0) { failures--; return new Response('Unavailable', { status: 503 }); }
        if (request.method === 'tools/call') reads++;
      }
      return fetch(url, options);
    } });
    assert.equal(await mcp.waitUntilReady({ boardId: p.project.id, onStatus: ready => statuses.push(ready) }), true);
    assert.deepEqual(statuses, [false, false, true]); assert.equal(reads, 1);
    assert.ok(mcp.codexArgs.includes('mcp_servers.boardly.required=true'));
    assert.ok(mcp.codexArgs.includes('mcp_servers.boardly.url=' + JSON.stringify(f.base + '/mcp')));
    // Executing through Node works even when archive/container copies remove the executable bit.
    const helper = path.join(f.root, 'non-executable-helper.cjs');
    fs.copyFileSync(path.resolve('scripts/cloud-mcp-headers.cjs'), helper); fs.chmodSync(helper, 0o600);
    assert.equal(JSON.parse(execFileSync(process.execPath, [helper, tokenFile], { encoding: 'utf8' })).Authorization, 'Bearer ' + token);
    let stopped = false;
    assert.equal(await mcp.waitUntilReady({ boardId: 999999, stopped: () => stopped, onStatus: ready => { assert.equal(ready, false); stopped = true; } }), false);

    const key = await f.api('/api/connections', { method: 'POST', body: { name: 'Cloud agent MCP test', scope: 'worker' } });
    const t = await f.api(`/api/boards/${p.project.id}/chat/threads`, { method: 'POST', body: {} });
    await f.api(`/api/chat/threads/${t.id}/messages`, { method: 'POST', body: { mode: 'work', content: 'Verify automatic startup recovery.' } });
    const fake = path.join(f.root, 'codex.cjs'), attempts = path.join(f.root, 'attempts'), mutations = path.join(f.root, 'mutations');
    fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const file=${JSON.stringify(attempts)},n=fs.existsSync(file)?Number(fs.readFileSync(file))+1:1;fs.writeFileSync(file,String(n));if(n===1){console.error('Error: required MCP servers failed to initialize: boardly');process.exitCode=1;return;}console.log(JSON.stringify({type:'turn.started'}));fs.appendFileSync(${JSON.stringify(mutations)},'once\\n');fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({state:'completed',summary:'MCP recovered and assignment verified.',next_step:'',blocker:'',next_action:''}));});`, { mode: 0o700 });
    const config = path.join(f.root, 'worker.json');
    fs.writeFileSync(config, JSON.stringify({ ...settings, token: key.token, workspaceRoot: path.join(f.root, 'workspaces'), codexCommand: fake, cloud: true, continuous: true, once: true }), { mode: 0o600 });
    fs.writeFileSync(tokenFile, 'bdly_expired_fixture');
    worker = spawn(process.execPath, [path.resolve('scripts/codex-worker.cjs'), config], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; worker.stdout.on('data', d => log += d); worker.stderr.on('data', d => log += d);
    const exited = new Promise((resolve, reject) => { const timer = setTimeout(() => { worker.kill(); reject(Error('Worker recovery timed out')); }, 25000); worker.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    let reconnecting = false;
    for (let i = 0; i < 100; i++) {
      const h = await f.api(`/api/chat/threads/${t.id}`);
      if (h.job.progress.includes('Reconnecting Boardly')) { assert.equal(h.job.status, 'running'); assert.equal(h.job.blocker_card_id, null); reconnecting = true; break; }
      await new Promise(r => setTimeout(r,20));
    }
    assert.ok(reconnecting); assert.equal(fs.existsSync(attempts), false, 'Do not start AI without MCP');
    fs.writeFileSync(tokenFile, token); // Credential rotation is observed without worker restart.
    assert.equal(await exited, 0, log); worker = null;
    const h = await f.api(`/api/chat/threads/${t.id}`);
    assert.equal(h.job.status, 'completed', h.job.error); assert.equal(h.job.blocker_card_id, null);
    assert.equal(fs.readFileSync(attempts, 'utf8'), '2'); assert.equal(fs.readFileSync(mutations, 'utf8'), 'once\n');
    assert.ok(!log.includes(token)); assert.ok(!log.includes(key.token));
    console.log('PASS: required MCP, non-executable helper, transient outage recovery, project access check, cancellation, credential rotation, no AI before readiness, required-startup retry and single execution');
  } finally { worker?.kill(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
