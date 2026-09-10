// End-to-end test for the sync-server: boots the real Express app against a
// temp data dir, mints tokens through the dev bootstrap, then drives push,
// pull (LWW, ties, tombstones, seq ordering), attachments, entitlement gating
// and validation as real HTTP clients would. The real Boardly DB is never
// touched. Run from the repo root: node sync-server/test/sync-server.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../app.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-sync-'));
process.env.DEV_BOOTSTRAP_KEY = 'test-dev-key';

let pass = 0;
function ok(msg) { console.log('  ok  ' + msg); pass++; }

async function main() {
  const app = createApp({ dataDir });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const base = `http://127.0.0.1:${listener.address().port}`;

  const authed = (token) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  });
  const push = (token, changes) => fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify({ changes }),
  });
  const pull = async (token, cursor, limit) => {
    const q = `cursor=${cursor}${limit ? `&limit=${limit}` : ''}`;
    const res = await fetch(`${base}/api/sync/pull?${q}`, { headers: authed(token) });
    return { status: res.status, body: await res.json() };
  };

  // ---- health ----
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.strictEqual(health.ok, true, 'healthz reports ok');
  ok('healthz');

  // ---- dev bootstrap ----
  const badKey = await fetch(`${base}/dev/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-key': 'wrong' },
    body: JSON.stringify({ email: 'a@example.com' }),
  });
  assert.strictEqual(badKey.status, 403, 'bad dev key rejected');
  ok('bad dev key -> 403');

  const boot = await (await fetch(`${base}/dev/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-key': 'test-dev-key' },
    body: JSON.stringify({ email: 'a@example.com' }),
  })).json();
  assert.ok(boot.token && boot.token.length >= 32, 'bootstrap returns a token');
  assert.ok(Number.isInteger(boot.accountId), 'bootstrap returns an accountId');
  const token = boot.token;
  ok('dev bootstrap mints a token');

  // ---- auth required ----
  const noAuth = await fetch(`${base}/api/sync/pull?cursor=0`);
  assert.strictEqual(noAuth.status, 401, 'pull without a token is refused');
  const badTok = await fetch(`${base}/api/sync/pull?cursor=0`, { headers: authed('nope') });
  assert.strictEqual(badTok.status, 401, 'pull with a bogus token is refused');
  ok('unauthenticated /api/* -> 401');

  // ---- push 3 entities across 2 tables, pull them back in seq order ----
  const r1 = await (await push(token, [
    { table: 'boards', uuid: 'board-1', updated_at: 1000, deleted: false, payload: { name: 'Roadmap' } },
    { table: 'cards', uuid: 'card-1', updated_at: 1001, deleted: false, payload: { title: 'Ship sync' } },
    { table: 'cards', uuid: 'card-2', updated_at: 1002, deleted: false, payload: { title: 'Write tests' } },
  ])).json();
  assert.strictEqual(r1.accepted, 3, 'all 3 accepted');
  assert.strictEqual(r1.rejected, 0, 'none rejected');
  assert.strictEqual(r1.maxSeq, 3, 'seq assigned 1..3');

  let page = await pull(token, 0);
  assert.strictEqual(page.body.changes.length, 3, 'pull returns all 3');
  assert.deepStrictEqual(page.body.changes.map((c) => c.seq), [1, 2, 3], 'seq order');
  assert.strictEqual(page.body.changes[0].table, 'boards');
  assert.deepStrictEqual(page.body.changes[0].payload, { name: 'Roadmap' }, 'payload round-trips');
  assert.strictEqual(page.body.cursor, 3, 'cursor is max seq returned');
  assert.strictEqual(page.body.hasMore, false, 'no more pages');

  page = await pull(token, page.body.cursor);
  assert.strictEqual(page.body.changes.length, 0, 'second pull is empty');
  assert.strictEqual(page.body.hasMore, false, 'hasMore false when caught up');
  ok('push 3 across 2 tables, pull in seq order, cursor paging');

  // ---- LWW: older write rejected, tie accepted (server tie-breaks) ----
  let r = await (await push(token, [
    { table: 'cards', uuid: 'card-x', updated_at: 100, deleted: false, payload: { title: 'v1' } },
  ])).json();
  assert.strictEqual(r.accepted, 1, 'first write accepted');

  r = await (await push(token, [
    { table: 'cards', uuid: 'card-x', updated_at: 50, deleted: false, payload: { title: 'stale' } },
  ])).json();
  assert.strictEqual(r.accepted, 0, 'older updated_at rejected');
  assert.strictEqual(r.rejected, 1, 'rejection counted');

  let found = (await pull(token, 0)).body.changes.find((c) => c.uuid === 'card-x');
  assert.strictEqual(found.updated_at, 100, 'stored row keeps the newer timestamp');
  assert.strictEqual(found.payload.title, 'v1', 'stored payload unchanged');

  r = await (await push(token, [
    { table: 'cards', uuid: 'card-x', updated_at: 100, deleted: false, payload: { title: 'tie-wins' } },
  ])).json();
  assert.strictEqual(r.accepted, 1, 'tie goes to the incoming write');
  found = (await pull(token, 0)).body.changes.find((c) => c.uuid === 'card-x');
  assert.strictEqual(found.payload.title, 'tie-wins', 'tie overwrote the payload');
  ok('LWW: older rejected, tie accepted (server tie-breaker)');

  // ---- tombstone ----
  const before = (await pull(token, 0)).body.cursor;
  r = await (await push(token, [
    { table: 'cards', uuid: 'card-x', updated_at: 200, deleted: true },
  ])).json();
  assert.strictEqual(r.accepted, 1, 'tombstone accepted');
  page = await pull(token, before);
  assert.strictEqual(page.body.changes.length, 1, 'tombstone is the only new change');
  assert.strictEqual(page.body.changes[0].deleted, true, 'row marked deleted');
  assert.strictEqual(page.body.changes[0].payload, null, 'tombstone payload is null');
  ok('tombstone syncs as deleted row with null payload');

  // ---- seq is strictly increasing per account, independent across accounts ----
  const seqs = [r1.maxSeq];
  r = await (await push(token, [
    { table: 'boards', uuid: 'board-2', updated_at: 1003, deleted: false, payload: { name: 'Second' } },
  ])).json();
  seqs.push(r.maxSeq);
  assert.ok(seqs[1] > seqs[0], 'maxSeq strictly increases across pushes');

  const boot2 = await (await fetch(`${base}/dev/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-key': 'test-dev-key' },
    body: JSON.stringify({ email: 'b@example.com' }),
  })).json();
  r = await (await push(boot2.token, [
    { table: 'boards', uuid: 'board-1', updated_at: 1, deleted: false, payload: { name: 'Other account' } },
  ])).json();
  assert.strictEqual(r.maxSeq, 1, 'second account seq starts at 1');
  const other = await pull(boot2.token, 0);
  assert.strictEqual(other.body.changes.length, 1, 'second account sees only its own rows');
  ok('seq strictly increasing per account, independent across accounts');

  // ---- attachments ----
  const bytes = Buffer.from('hello sync \x00\x01\x02');
  const put = await fetch(`${base}/api/sync/attachments/att-1`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  assert.strictEqual(put.status, 200, 'PUT stores bytes');

  const head = await fetch(`${base}/api/sync/attachments/att-1`, {
    method: 'HEAD',
    headers: authed(token),
  });
  assert.strictEqual(head.status, 200, 'HEAD finds the stored attachment');
  assert.strictEqual(Number(head.headers.get('content-length')), bytes.length, 'HEAD size matches');

  const got = await fetch(`${base}/api/sync/attachments/att-1`, { headers: authed(token) });
  assert.strictEqual(got.status, 200, 'GET succeeds');
  assert.strictEqual(got.headers.get('content-type'), 'application/octet-stream', 'mime round-trips');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes), 'exact bytes round-trip');

  const missing = await fetch(`${base}/api/sync/attachments/att-missing`, { headers: authed(token) });
  assert.strictEqual(missing.status, 404, 'GET of a missing attachment -> 404');
  ok('attachment PUT/HEAD/GET round-trip, missing -> 404');

  // ---- suspended entitlement blocks sync ----
  const boot3 = await (await fetch(`${base}/dev/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-key': 'test-dev-key' },
    body: JSON.stringify({ email: 'c@example.com', entitlement: 'suspended' }),
  })).json();
  const blocked = await push(boot3.token, [
    { table: 'boards', uuid: 'board-1', updated_at: 1, deleted: false, payload: {} },
  ]);
  assert.strictEqual(blocked.status, 403, 'suspended account -> 403');
  const blockedBody = await blocked.json();
  assert.strictEqual(blockedBody.error, 'subscription_inactive', 'clear error code');
  assert.ok(/local data is safe/.test(blockedBody.message), 'reassuring message');
  ok('suspended entitlement -> 403 subscription_inactive');

  // ---- account status ----
  const statusRes = await fetch(`${base}/api/account/status`, { headers: authed(token) });
  const status = await statusRes.json();
  assert.strictEqual(statusRes.status, 200, 'status endpoint works');
  assert.strictEqual(status.active, true, 'active account reports active');
  assert.strictEqual(status.status, 'active');
  ok('account status endpoint');

  // ---- validation: bad table is a 400, not a 500 ----
  const badTable = await push(token, [
    { table: 'activity', uuid: 'x', updated_at: 1, deleted: false, payload: {} },
  ]);
  assert.strictEqual(badTable.status, 400, 'unknown table rejected with 400');
  const badUuid = await push(token, [
    { table: 'cards', uuid: 'y', updated_at: 'soon', deleted: false, payload: {} },
  ]);
  assert.strictEqual(badUuid.status, 400, 'non-integer updated_at rejected with 400');
  ok('invalid push input -> 400 (not 500)');

  listener.close();
  console.log(`\nAll ${pass} sync-server tests passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
