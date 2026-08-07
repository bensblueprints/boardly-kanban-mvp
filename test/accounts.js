// Accounts + API tokens test — cloud semantics (multi-user registration,
// DB sessions, owner scoping, Bearer tokens). Locally it runs against the
// SQLite store forced into cloud mode (no Postgres on dev machines); with
// DATABASE_URL set it runs against real Postgres — that's the task #8
// validation path. Run: node test/accounts.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-accounts-'));
// No opts needed when DATABASE_URL is set — openStore picks Postgres up from
// the environment and selects cloud mode itself.
const appOpts = process.env.DATABASE_URL ? { dataDir } : { dataDir, mode: 'cloud' };

let base = '';
let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

// One cookie jar per user, like a browser per account.
function client() {
  let cookie = '';
  return {
    async api(method, url, body, opts = {}) {
      const headers = { cookie };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      let payload;
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
  };
}

async function main() {
  const app = await createApp(appOpts);
  const listener = await new Promise((resolve) => {
    const l = app.listen(0, '127.0.0.1', () => resolve(l));
  });
  base = `http://127.0.0.1:${listener.address().port}`;

  const A = client();
  const B = client();

  try {
    // ---- register validation ----
    let r = await A.api('POST', '/api/register', { email: 'not-an-email', password: 'longenough' });
    assert.equal(r.status, 400);
    r = await A.api('POST', '/api/register', { email: 'a@example.com', password: 'short' });
    assert.equal(r.status, 400);
    ok('register rejects bad email and short password');

    // ---- register / me ----
    r = await A.api('POST', '/api/register', { email: 'A@Example.com', password: 'password-a', name: 'Ann' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user.email, 'a@example.com', 'email is lowercased');
    assert.equal(r.json.user.name, 'Ann');
    const userA = r.json.user;
    r = await A.api('GET', '/api/me');
    assert.equal(r.json.authed, true);
    assert.equal(r.json.user.id, userA.id);
    assert.equal(r.json.mode, 'cloud', '/api/me exposes the mode for the frontend');
    ok('register logs in, /api/me reflects the account');

    // ---- duplicate email ----
    const C = client();
    r = await C.api('POST', '/api/register', { email: 'a@example.com', password: 'whatever-pass' });
    assert.equal(r.status, 409);
    ok('duplicate email rejected');

    // ---- A builds a board ----
    const board = (await A.api('POST', '/api/boards', { name: 'Secret Plans' })).json;
    assert.equal(board.owner_id, userA.id, 'board stamped with owner_id');
    assert.match(board.uid, /^[0-9a-f-]{36}$/, 'board has a UUID');
    assert(board.rev > 0 && board.updated_at, 'board stamped with rev + updated_at');
    const list = (await A.api('POST', `/api/boards/${board.id}/lists`, { name: 'Todo' })).json;
    const card = (await A.api('POST', `/api/lists/${list.id}/cards`, { title: 'Top secret' })).json;
    assert.match(card.uid, /^[0-9a-f-]{36}$/);
    assert(card.rev > board.rev, 'rev increases across writes');
    const label = (await A.api('POST', `/api/boards/${board.id}/labels`, { name: 'Classified' })).json;
    ok('board/list/card/label created with uid, rev, updated_at, owner');

    // ---- logout / login ----
    r = await A.api('POST', '/api/logout');
    assert.equal(r.json.ok, true);
    r = await A.api('GET', '/api/me');
    assert.equal(r.json.authed, false);
    r = await A.api('GET', '/api/boards');
    assert.equal(r.status, 401, 'logged-out session rejected');
    r = await A.api('POST', '/api/login', { email: 'a@example.com', password: 'wrong-password' });
    assert.equal(r.status, 401);
    r = await A.api('POST', '/api/login', { email: 'a@example.com', password: 'password-a' });
    assert.equal(r.status, 200);
    assert.equal((await A.api('GET', '/api/boards')).json.length, 1);
    ok('logout kills the session; wrong password rejected; login restores access');

    // ---- user B is isolated ----
    r = await B.api('POST', '/api/register', { email: 'b@example.com', password: 'password-b' });
    assert.equal(r.status, 200);
    assert.equal((await B.api('GET', '/api/boards')).json.length, 0, 'B sees no boards');

    const bBoard = (await B.api('POST', '/api/boards', { name: 'B board' })).json;
    const bList = (await B.api('POST', `/api/boards/${bBoard.id}/lists`, { name: 'B list' })).json;
    const bCard = (await B.api('POST', `/api/lists/${bList.id}/cards`, { title: 'B card' })).json;

    const attempts = [
      ['GET', `/api/boards/${board.id}`],
      ['GET', `/api/boards/${board.id}/activity`],
      ['GET', `/api/boards/${board.id}/archived`],
      ['GET', `/api/boards/${board.id}/cards`],
      ['GET', `/api/boards/${board.id}/export`],
      ['PATCH', `/api/boards/${board.id}`, { name: 'pwned' }],
      ['DELETE', `/api/boards/${board.id}`],
      ['POST', `/api/boards/${board.id}/lists`, { name: 'pwned' }],
      ['GET', `/api/cards/${card.id}`],
      ['PATCH', `/api/cards/${card.id}`, { title: 'pwned' }],
      ['DELETE', `/api/cards/${card.id}`],
      ['PATCH', `/api/lists/${list.id}`, { name: 'pwned' }],
      ['DELETE', `/api/labels/${label.id}`],
      ['POST', `/api/cards/${card.id}/comments`, { body: 'pwned' }],
      ['POST', `/api/cards/${card.id}/checklists`, {}],
      ['POST', `/api/cards/${bCard.id}/labels/${label.id}`],   // A's label on B's card
      ['POST', `/api/cards/${bCard.id}/move`, { list_id: list.id, position: 0 }] // into A's list
    ];
    for (const [method, url, body] of attempts) {
      r = await B.api(method, url, body);
      assert.equal(r.status, 404, `B ${method} ${url} → ${r.status} ${JSON.stringify(r.json)}`);
    }
    ok('cross-user reads and writes all 404 (boards, cards, lists, labels, export, move)');

    // A's data untouched by the attempts
    r = await A.api('GET', `/api/boards/${board.id}`);
    assert.equal(r.json.name, 'Secret Plans');
    assert.equal(r.json.lists[0].cards[0].title, 'Top secret');
    r = await A.api('GET', `/api/cards/${card.id}`);
    assert.equal(r.json.comments.length, 0);
    ok("A's data untouched by B's attempts");

    // ---- API tokens ----
    r = await A.api('POST', '/api/tokens', { name: 'sync' });
    assert.equal(r.status, 200);
    const token = r.json.token;
    assert(token && token.length === 48, 'full token returned once');
    assert.equal(r.json.prefix, token.slice(0, 8));
    r = await A.api('GET', '/api/tokens');
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].token, undefined, 'list never exposes the token');
    const tokenId = r.json[0].id;
    ok('token created, shown once, listed by prefix only');

    // Bearer auth resolves to the right user
    const anon = client();
    r = await anon.api('GET', '/api/me', undefined, { token });
    assert.equal(r.json.authed, true);
    assert.equal(r.json.user.id, userA.id);
    r = await anon.api('GET', '/api/boards', undefined, { token });
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].name, 'Secret Plans', "Bearer token sees A's boards only");
    r = await anon.api('GET', `/api/boards/${bBoard.id}`, undefined, { token });
    assert.equal(r.status, 404, "A's token cannot reach B's board");
    ok('Bearer token authenticates as its owner, scoped like the cookie');

    // B cannot revoke A's token; A revokes it; it stops working
    r = await B.api('DELETE', `/api/tokens/${tokenId}`);
    assert.equal(r.status, 404);
    r = await A.api('DELETE', `/api/tokens/${tokenId}`);
    assert.equal(r.json.ok, true);
    r = await anon.api('GET', '/api/boards', undefined, { token });
    assert.equal(r.status, 401);
    r = await anon.api('GET', '/api/boards', undefined, { token: 'f'.repeat(48) });
    assert.equal(r.status, 401, 'garbage token rejected');
    ok('token revoke: cross-user 404, revoked token 401');

    console.log(`\nAll ${pass} account checks passed.`);
  } finally {
    listener.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('\nACCOUNTS TEST FAILED:', e);
  process.exit(1);
});
