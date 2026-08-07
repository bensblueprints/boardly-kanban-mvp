// Cloud MCP test — the streamable-HTTP endpoint mounted on the cloud app at
// /mcp, authed by API token and scoped to that user's boards. Runs in forced
// cloud mode locally; with DATABASE_URL set it runs against real Postgres
// (the task #8 validation drill). Run: node test/mcp-cloud.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-mcpcloud-'));

let base = '';
let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
let nextId = 1;

// Streamable HTTP may reply as SSE; pull the JSON out of the data: line.
async function rpc(token, method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: text };
  const line = text.includes('data:')
    ? text.split('\n').find((l) => l.startsWith('data:')).slice(5).trim()
    : text;
  return { status: res.status, json: JSON.parse(line) };
}

async function callTool(token, name, args) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert(r.json, `${name}: HTTP ${r.status} ${r.body || ''}`);
  const result = r.json.result;
  if (result?.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

async function main() {
  const appOpts = process.env.DATABASE_URL ? { dataDir } : { dataDir, mode: 'cloud' };
  const app = await createApp(appOpts);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  base = `http://127.0.0.1:${listener.address().port}`;
  const store = app.locals.store;

  // Unique emails so the test is re-runnable against a shared Postgres.
  const stamp = Date.now();
  const api = (cookie) => async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    // ---- two users, one token each ----
    const jar = {};
    const tokens = {};
    for (const who of ['a', 'b']) {
      const res = await fetch(base + '/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `mcp-${who}-${stamp}@test.dev`, password: 'password-123' })
      });
      jar[who] = res.headers.get('set-cookie').split(';')[0];
      tokens[who] = (await api(jar[who])('POST', '/api/tokens', { name: who })).json.token;
    }
    ok('two users registered, one API token each');

    // ---- auth gate ----
    let r = await rpc(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.status, 401, 'no token → 401');
    r = await rpc('f'.repeat(48), 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.status, 401, 'garbage token → 401');
    ok('MCP endpoint rejects missing and invalid tokens');

    // ---- initialize + tools/list with a valid token ----
    r = await rpc(tokens.a, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.json.result.serverInfo.name, 'boardly');
    r = await rpc(tokens.a, 'tools/list', {});
    assert(r.json.result.tools.length >= 15, 'tools listed');
    ok('initialize + tools/list over Bearer auth');

    // ---- A builds via MCP; B sees none of it ----
    const board = await callTool(tokens.a, 'create_board', { name: 'A board' });
    const list = await callTool(tokens.a, 'create_list', { board_id: board.id, name: 'Todo' });
    const card = await callTool(tokens.a, 'create_card', { list_id: list.id, title: 'A card' });

    const aBoards = await callTool(tokens.a, 'list_boards', {});
    assert.equal(aBoards.length, 1);
    assert.equal(aBoards[0].name, 'A board');
    const bBoards = await callTool(tokens.b, 'list_boards', {});
    assert.equal(bBoards.length, 0, 'B lists no boards');
    ok('MCP creates work for A; B sees nothing');

    // ---- B cannot touch A's rows through any tool ----
    let threw = null;
    try { await callTool(tokens.b, 'get_card', { card_id: card.id }); } catch (e) { threw = e; }
    assert(threw && /not found/i.test(threw.message), 'B get_card on A card → not found');
    threw = null;
    try { await callTool(tokens.b, 'update_card', { card_id: card.id, title: 'pwned' }); } catch (e) { threw = e; }
    assert(threw && /not found/i.test(threw.message), 'B update_card on A card → not found');
    threw = null;
    try { await callTool(tokens.b, 'move_card', { card_id: card.id, list_id: list.id, position: 0 }); } catch (e) { threw = e; }
    assert(threw && /not found/i.test(threw.message), 'B move_card with A card → not found');
    const found = await callTool(tokens.b, 'find_cards', { query: 'A card' });
    assert.equal(found.length, 0, 'B find_cards cannot search A cards');
    ok('cross-user MCP reads/writes all fail as not-found');

    // A's data is untouched by the attempts
    const aCard = await callTool(tokens.a, 'get_card', { card_id: card.id });
    assert.equal(aCard.title, 'A card');
    ok("A's card untouched by B's attempts");

    // ---- scope enforcement: a sync-only token gets 403 ----
    await store.run("UPDATE api_tokens SET scope = 'sync' WHERE token_hash = (SELECT token_hash FROM api_tokens WHERE name = 'a')");
    r = await rpc(tokens.a, 'tools/list', {});
    assert.equal(r.status, 403, 'sync-scoped token → 403 on /mcp');
    await store.run("UPDATE api_tokens SET scope = 'sync,mcp' WHERE name = 'a'");
    r = await rpc(tokens.a, 'tools/list', {});
    assert(r.json?.result?.tools, 'mcp scope restored → works again');
    ok('token scope is enforced (mcp required)');

    // ---- revoked token → 401 ----
    const tokenId = (await api(jar.b)('GET', '/api/tokens')).json[0].id;
    await api(jar.b)('DELETE', `/api/tokens/${tokenId}`);
    r = await rpc(tokens.b, 'tools/list', {});
    assert.equal(r.status, 401, 'revoked token → 401');
    ok('revoked token rejected');

    console.log(`\nAll ${pass} cloud-MCP checks passed.`);
  } finally {
    listener.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('\nCLOUD MCP TEST FAILED:', e);
  process.exit(1);
});
