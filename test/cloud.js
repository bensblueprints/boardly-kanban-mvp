const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCloudApp, readCloudConfig, workspacePath } = require('../server/cloud');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-cloud-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  dataDir: root, origin: 'https://boardly.example.com', ownerId: 'user_owner', ownerOnly: true,
  planSlugs: ['boardly_pro'],
  publishableKey: 'pk_test_' + Buffer.from('boardly-test.clerk.accounts.dev$').toString('base64'),
  secretKey: 'sk_test_not_a_real_secret',
  jwtKey: publicKey.export({ type: 'spki', format: 'pem' }),
};

// Exercise the actual Clerk middleware with locally signed JWTs, including
// tampering and expired sessions. No authentication middleware is mocked.
function token(userId, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'local-test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: 'https://boardly-test.clerk.accounts.dev', sub: userId, sid: 'sess_test',
    iat: now, nbf: now - 10, exp: now + 300, azp: config.origin,
    v: 2, fva: [0, -1], ...extra,
  })).toString('base64url');
  const signed = `${header}.${claims}`;
  return `${signed}.${crypto.sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
}

async function run() {
  assert.throws(() => readCloudConfig({}), /Missing required cloud setting/);
  assert.throws(() => workspacePath(root, '../owner'), /valid Clerk user ID/);
  const env = { CLERK_PUBLISHABLE_KEY: config.publishableKey, CLERK_SECRET_KEY: config.secretKey,
    BOARDLY_OWNER_USER_ID: config.ownerId, BOARDLY_ORIGIN: config.origin };
  assert.equal(readCloudConfig(env).ownerOnly, true);
  const freeConfig = readCloudConfig({ ...env, BOARDLY_OWNER_ONLY: 'false' });
  assert.equal(freeConfig.ownerOnly, false);
  assert.equal(freeConfig.freeEnabled, true, 'public signup starts with Basic Free without paid plans');
  assert.throws(() => readCloudConfig({ ...env, BOARDLY_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.throws(() => readCloudConfig({ ...env, BOARDLY_ORIGIN: 'http://localhost:5315', NODE_ENV: 'production' }), /HTTPS/);

  let app = createCloudApp(config);
  let server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const owner = token('user_owner');
  const customer = token('user_customer', { pla: 'u:boardly_pro' });
  const request = (route, session, options = {}) => fetch(base + route, {
    ...options, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...options.headers },
  });
  const write = (route, session, body, method = 'POST') => request(route, session, {
    method, headers: { 'content-type': 'application/json', origin: config.origin }, body: JSON.stringify(body),
  });

  try {
    assert.equal((await request('/healthz')).status, 200);
    const publicConfig = await (await request('/api/auth-config')).json();
    assert.equal(publicConfig.mode, 'clerk');
    assert.equal(publicConfig.secretKey, undefined);
    assert.equal((await request('/api/boards')).status, 401);
    assert.equal((await request('/api/boards', null, { headers: { 'x-user-id': 'user_owner', cookie: 'sid=forged' } })).status, 401);
    assert.equal((await request('/api/boards', customer)).status, 403, 'owner-only overrides paid plans');
    assert.equal((await request('/api/boards', token('user_owner', { exp: 1 }))).status, 401);
    assert.equal((await request('/api/boards', token('user_owner', { azp: 'https://evil.example' }))).status, 401);
    const native = token('user_owner', { azp: undefined });
    assert.equal((await (await request('/api/me', native)).json()).allowed, true, 'native Bearer session may omit azp');
    assert.equal((await request('/api/boards', native, { headers: { origin: 'https://evil.example' } })).status, 403, 'native tokens cannot bypass request origin checks');
    assert.equal((await request('/api/boards', token('user_owner', { azp: undefined, exp: 1 }))).status, 401, 'native sessions still expire');
    assert.equal((await request('/api/boards', token('user_owner', { azp: null }))).status, 401, 'malformed origin claims are rejected');
    assert.equal((await request('/api/boards', null, { headers: { cookie: '__session=' + native } })).status, 401, 'native sessions are not accepted through cookies');
    assert.equal((await request('/api/boards', native.slice(0, -5) + 'AAAAA')).status, 401, 'native signature tampering is rejected');
    const pieces = owner.split('.');
    pieces[1] = Buffer.from(JSON.stringify({ sub: 'user_customer', exp: 9999999999 })).toString('base64url');
    assert.equal((await request('/api/boards', pieces.join('.'))).status, 401);
    assert.equal((await write('/api/login', owner, { password: 'admin' })).status, 404);
    assert.equal((await request('/auth/auto?token=forged')).status, 404);
    const me = await (await request('/api/me', owner)).json();
    assert.equal(me.allowed, true);
    assert.equal(me.plan, 'owner');
    assert.equal((await request('/api/boards', owner, { method: 'POST', headers: {
      'content-type': 'application/json', origin: 'https://evil.example',
    }, body: JSON.stringify({ name: 'CSRF' }) })).status, 403);
    for (const route of ['/api/mcp', '/api/mcp/connect', '/api/sync/status', '/api/coach', '/API/MCP']) {
      assert.equal((await request(route, owner)).status, 404, route);
    }
    const board = await (await write('/api/boards', owner, { name: 'Owner private board' })).json();
    assert.ok(board.id);
    const list = await (await write(`/api/boards/${board.id}/lists`, owner, { name: 'To Do' })).json();
    const card = await (await write(`/api/lists/${list.id}/cards`, owner, { title: 'Private card' })).json();
    const form = new FormData();
    form.set('file', new Blob(['private attachment'], { type: 'text/plain' }), 'private.txt');
    const uploaded = await (await request(`/api/cards/${card.id}/attachments`, owner, {
      method: 'POST', headers: { origin: config.origin }, body: form,
    })).json();
    assert.ok(uploaded.url);
    assert.equal((await request(uploaded.url)).status, 401);
    let file = await request(uploaded.url, owner);
    assert.equal(await file.text(), 'private attachment');
    assert.match(file.headers.get('cache-control'), /no-store/);
    assert.match(file.headers.get('content-disposition'), /attachment/);
    assert.equal((await request(uploaded.url, customer)).status, 403);
    assert.equal(fs.existsSync(workspacePath(root, 'user_customer')), false);
    console.log('PASS: verified Clerk sessions, owner-only gate, tampering/expiry/origin rejection and private uploads');

    await new Promise(resolve => server.close(resolve));
    app.closeWorkspaces();
    app = createCloudApp({ ...config, ownerOnly: false });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const ownerBoards = await (await request('/api/boards', owner)).json();
    assert.equal(ownerBoards[0].name, 'Owner private board', 'data persists across restart');
    assert.deepEqual(await (await request('/api/boards', customer)).json(), []);
    assert.equal((await request(`/api/cards/${card.id}`, customer)).status, 404);
    assert.equal((await request(uploaded.url, customer)).status, 404);
    assert.equal((await request(uploaded.url, token('user_customer', { azp: undefined, pla: 'u:boardly_pro' }))).status, 404, 'native customer tokens remain isolated from owner files');
    assert.equal((await request(`/api/boards/${board.id}/export`, customer)).status, 404);
    assert.equal((await request(`/api/boards/${board.id}`, customer, { method: 'DELETE' })).status, 404);
    assert.equal((await request('/api/boards', token('user_unpaid'))).status, 403);
    assert.equal((await request('/api/boards', token('user_orgonly', { pla: 'o:boardly_pro' }))).status, 403, 'personal subscription required');
    assert.equal((await request('/api/boards', token('user_customer'))).status, 403, 'lost entitlement revokes existing workspace access');
    const customerBoard = await (await write('/api/boards', customer, { name: 'Customer board', user_id: 'user_owner', plan: 'owner' })).json();
    assert.ok(customerBoard.id);
    assert.equal((await write(`/api/boards/${board.id}/environment/OWNER_KEY`, owner, { value: 'synthetic-owner-only-value' }, 'PUT')).status, 200);
    assert.deepEqual(await (await request(`/api/boards/${customerBoard.id}/environment?user_id=user_owner`, customer)).json(), []);
    assert.equal((await write(`/api/boards/${customerBoard.id}/environment/CUSTOMER_KEY`, customer, { value: 'synthetic-customer-value' }, 'PUT')).status, 200);
    assert.deepEqual((await (await request(`/api/boards/${board.id}/environment`, owner)).json()).map(v => v.name), ['OWNER_KEY']);
    assert.equal((await request(`/api/boards/${customerBoard.id}/environment/OWNER_KEY`, customer, { method: 'DELETE', headers: { origin: config.origin } })).status, 404);
    assert.equal((await (await request('/api/boards', owner)).json())[0].name, 'Owner private board');
    assert.equal((await (await request('/api/boards?user_id=user_owner', customer)).json())[0].name, 'Customer board');
    console.log('PASS: paid-plan gate, entitlement revocation, separate workspaces, ID spoofing and restart persistence');
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.closeWorkspaces();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
