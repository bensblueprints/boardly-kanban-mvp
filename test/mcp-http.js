// End-to-end test for the in-app MCP integration.
// Boots the real Express app against a temp data dir, logs in, starts the MCP
// server through the API, then drives it as a real MCP client would: bearer
// auth, initialize, tools/list, tools/call. Also checks auth rejection, token
// rotation, client-config writing and stop/restart persistence.
// The real Boardly DB is never touched. Run: node test/mcp-http.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-mcphttp-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-fakehome-'));
// Redirect client-config writes into a throwaway home so we never touch the
// user's real ~/.claude.json.
process.env.APPDATA = HOME;
os.homedir = () => HOME;

const MCP_PORT = 18765; // not the default 8765, so a running Boardly won't clash
let pass = 0;
function ok(msg) { console.log('  ok  ' + msg); pass++; }

async function rpc(url, token, method, params, id) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: text };
  // Streamable HTTP may reply as SSE; pull the JSON out of the data: line.
  const line = text.includes('data:')
    ? text.split('\n').find((l) => l.startsWith('data:')).slice(5).trim()
    : text;
  return { status: res.status, json: JSON.parse(line) };
}

async function main() {
  const app = createApp({ dataDir, adminPassword: 'admin' });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const base = `http://127.0.0.1:${listener.address().port}`;

  // ---- log in ----
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin' })
  });
  assert.strictEqual(login.status, 200, 'login should succeed');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const authed = { 'content-type': 'application/json', cookie };
  ok('logged in');

  // ---- status before starting ----
  let status = await (await fetch(`${base}/api/mcp`, { headers: authed })).json();
  assert.strictEqual(status.running, false, 'should not be running yet');
  assert.strictEqual(status.enabled, false, 'should not be enabled yet');
  assert.ok(status.token && status.token.length >= 32, 'token generated on first read');
  ok('initial status: stopped, token generated');

  // ---- unauthenticated API access is refused ----
  const noAuth = await fetch(`${base}/api/mcp`);
  assert.strictEqual(noAuth.status, 401, '/api/mcp requires a session');
  ok('API requires auth');

  // ---- start ----
  const started = await fetch(`${base}/api/mcp/start`, {
    method: 'POST', headers: authed, body: JSON.stringify({ port: MCP_PORT })
  });
  status = await started.json();
  assert.strictEqual(started.status, 200, 'start should succeed: ' + JSON.stringify(status));
  assert.strictEqual(status.running, true, 'should be running');
  assert.strictEqual(status.port, MCP_PORT, 'should use requested port');
  const url = status.url;
  const token = status.token;
  ok(`MCP started on ${url}`);

  // ---- bad token is rejected ----
  const bad = await rpc(url, 'not-the-token', 'initialize', {}, 1);
  assert.strictEqual(bad.status, 401, 'wrong bearer token must be rejected');
  const none = await rpc(url, null, 'initialize', {}, 1);
  assert.strictEqual(none.status, 401, 'missing bearer token must be rejected');
  ok('bad/missing token rejected with 401');

  // ---- initialize ----
  const init = await rpc(url, token, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'boardly-test', version: '1.0.0' }
  }, 1);
  assert.strictEqual(init.json.result.serverInfo.name, 'boardly', 'server identifies as boardly');
  ok('initialize handshake');

  // ---- tools/list ----
  const tools = await rpc(url, token, 'tools/list', {}, 2);
  const names = tools.json.result.tools.map((t) => t.name);
  for (const expected of ['list_boards', 'create_board', 'create_card', 'move_card', 'add_checklist']) {
    assert.ok(names.includes(expected), `tool ${expected} exposed`);
  }
  ok(`tools/list exposed ${names.length} tools`);

  // ---- create a board through MCP, verify via the REST API ----
  const created = await rpc(url, token, 'tools/call', {
    name: 'create_board', arguments: { name: 'From MCP', emoji: '🤖' }
  }, 3);
  const board = JSON.parse(created.json.result.content[0].text);
  assert.strictEqual(board.name, 'From MCP', 'board created via MCP');

  const viaRest = await (await fetch(`${base}/api/boards`, { headers: authed })).json();
  assert.ok(viaRest.some((b) => b.id === board.id && b.name === 'From MCP'),
    'board created over MCP is visible to the Boardly UI');
  ok('MCP write is visible through the app REST API (same DB handle)');

  // ---- a card, to prove nested writes work ----
  const list = JSON.parse((await rpc(url, token, 'tools/call', {
    name: 'create_list', arguments: { board_id: board.id, name: 'Today' }
  }, 4)).json.result.content[0].text);
  const card = JSON.parse((await rpc(url, token, 'tools/call', {
    name: 'create_card', arguments: { list_id: list.id, title: 'Ship the MCP panel' }
  }, 5)).json.result.content[0].text);
  assert.strictEqual(card.title, 'Ship the MCP panel');
  ok('created list + card over MCP');

  // ---- one-click client config ----
  const connect = await (await fetch(`${base}/api/mcp/connect`, {
    method: 'POST', headers: authed, body: JSON.stringify({ client: 'claude-code' })
  })).json();
  assert.ok(connect.ok, 'connect should succeed: ' + JSON.stringify(connect));
  const written = JSON.parse(fs.readFileSync(connect.file, 'utf8'));
  assert.strictEqual(written.mcpServers.boardly.url, url, 'config points at our endpoint');
  assert.strictEqual(written.mcpServers.boardly.headers.Authorization, `Bearer ${token}`);
  ok('one-click connect wrote a valid client config');

  // ---- connect must preserve unrelated existing config ----
  const cfgFile = connect.file;
  const withExtra = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  withExtra.someOtherSetting = 'keep me';
  withExtra.mcpServers.otherServer = { type: 'http', url: 'http://example.invalid' };
  fs.writeFileSync(cfgFile, JSON.stringify(withExtra, null, 2));
  await fetch(`${base}/api/mcp/connect`, {
    method: 'POST', headers: authed, body: JSON.stringify({ client: 'claude-code' })
  });
  const merged = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.strictEqual(merged.someOtherSetting, 'keep me', 'unrelated keys preserved');
  assert.ok(merged.mcpServers.otherServer, 'other MCP servers preserved');
  ok('connect merges without clobbering existing config');

  // ---- token rotation invalidates the old token ----
  const rotated = await (await fetch(`${base}/api/mcp/token`, { method: 'POST', headers: authed })).json();
  assert.notStrictEqual(rotated.token, token, 'token changed');
  assert.strictEqual(rotated.running, true, 'still running after rotation');
  const stale = await rpc(url, token, 'tools/list', {}, 6);
  assert.strictEqual(stale.status, 401, 'old token no longer works');
  const fresh = await rpc(url, rotated.token, 'tools/list', {}, 7);
  assert.ok(fresh.json.result.tools.length > 0, 'new token works');
  ok('token rotation invalidates old token, new token works');

  // ---- rotation marks the already-connected client as stale ----
  const afterRotate = await (await fetch(`${base}/api/mcp`, { headers: authed })).json();
  const cc = afterRotate.clients.find((c) => c.id === 'claude-code');
  assert.ok(cc.connected && cc.stale, 'client shows connected but stale after rotation');
  ok('status reports connected clients as stale after rotation');

  // ---- stop ----
  const stopped = await (await fetch(`${base}/api/mcp/stop`, { method: 'POST', headers: authed })).json();
  assert.strictEqual(stopped.running, false, 'stopped');
  assert.strictEqual(stopped.enabled, false, 'user stop clears enabled');
  let refused = false;
  try {
    await rpc(url, rotated.token, 'tools/list', {}, 8);
  } catch {
    refused = true;
  }
  assert.ok(refused, 'endpoint is gone after stop');
  ok('stop closes the endpoint');

  // ---- enabled flag persists across a restart ----
  await fetch(`${base}/api/mcp/start`, {
    method: 'POST', headers: authed, body: JSON.stringify({ port: MCP_PORT })
  });
  await app.shutdownMcp(); // simulates app quit — must NOT clear `enabled`
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8'));
  assert.strictEqual(settings.enabled, true, 'quit leaves the integration enabled');

  const app2 = createApp({ dataDir, adminPassword: 'admin' });
  const handle = await app2.startMcpIfEnabled();
  assert.ok(handle, 'autostarts on next launch when enabled');
  const afterRestart = await rpc(handle.url, settings.token, 'tools/list', {}, 9);
  assert.ok(afterRestart.json.result.tools.length > 0, 'works after restart on the same URL');
  assert.strictEqual(handle.url, url, 'same stable URL after restart');
  ok('autostarts on the same URL after an app restart');
  await app2.shutdownMcp();

  listener.close();
  console.log(`\nAll ${pass} MCP HTTP tests passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
