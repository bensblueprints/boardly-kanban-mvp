// Share-links test — owner-scoped management + the public read-only snapshot
// and its safe-fields contract. Forced cloud mode locally, real Postgres when
// DATABASE_URL is set. Run: node test/share.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-share-'));

let base = '';
let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

function client() {
  let cookie = '';
  return {
    async api(method, url, body) {
      const headers = { cookie };
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
  const appOpts = process.env.DATABASE_URL ? { dataDir } : { dataDir, mode: 'cloud' };
  const app = await createApp(appOpts);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  base = `http://127.0.0.1:${listener.address().port}`;

  const A = client();
  const B = client();
  const anon = client();

  try {
    // ---- A builds a board with one of everything, plus archived items ----
    const stamp = Date.now();
    await A.api('POST', '/api/register', { email: `share-a-${stamp}@test.dev`, password: 'password-123' });
    await B.api('POST', '/api/register', { email: `share-b-${stamp}@test.dev`, password: 'password-123' });

    const board = (await A.api('POST', '/api/boards', { name: 'Shared Board', description: 'For the client' })).json;
    const list = (await A.api('POST', `/api/boards/${board.id}/lists`, { name: 'Todo' })).json;
    const archivedList = (await A.api('POST', `/api/boards/${board.id}/lists`, { name: 'Old stuff' })).json;
    const card = (await A.api('POST', `/api/lists/${list.id}/cards`, { title: 'Visible card', description: 'Shown publicly', due_date: '2026-09-01' })).json;
    const label = (await A.api('POST', `/api/boards/${board.id}/labels`, { name: 'Urgent', color: '#ef4444' })).json;
    await A.api('POST', `/api/cards/${card.id}/labels/${label.id}`);
    const cl = (await A.api('POST', `/api/cards/${card.id}/checklists`, { title: 'Steps' })).json;
    await A.api('POST', `/api/checklists/${cl.id}/items`, { text: 'Do the thing' });
    await A.api('POST', `/api/cards/${card.id}/comments`, { body: 'private-discussion-marker' });
    const archivedCard = (await A.api('POST', `/api/lists/${list.id}/cards`, { title: 'archived-marker' })).json;
    await A.api('PATCH', `/api/cards/${archivedCard.id}`, { archived: true });
    await A.api('PATCH', `/api/lists/${archivedList.id}`, { archived: true });

    // ---- owner scoping ----
    let r = await B.api('POST', `/api/boards/${board.id}/share`, { label: 'nope' });
    assert.equal(r.status, 404, 'B cannot create a link on A board');
    r = await B.api('GET', `/api/boards/${board.id}/share`);
    assert.equal(r.status, 404, 'B cannot list A links');
    ok('share management is owner-scoped');

    // ---- create + list ----
    const link = (await A.api('POST', `/api/boards/${board.id}/share`, { label: 'For the client' })).json;
    assert.match(link.token, /^[a-f0-9]{32}$/, 'unguessable token');
    const links = (await A.api('GET', `/api/boards/${board.id}/share`)).json;
    assert.equal(links.length, 1);
    assert.equal(links[0].label, 'For the client');
    r = await B.api('DELETE', `/api/share/${link.id}`);
    assert.equal(r.status, 404, 'B cannot revoke A link');
    ok('create + list work; cross-user revoke 404s');

    // ---- the public snapshot and its contract ----
    const pub = await anon.api('GET', `/api/share/${link.token}`);
    assert.equal(pub.status, 200);
    const snap = pub.json;
    assert.equal(snap.board.name, 'Shared Board');
    assert.equal(snap.board.description, 'For the client');
    assert.equal(snap.lists.length, 1, 'archived list excluded');
    assert.equal(snap.lists[0].name, 'Todo');
    const pubCard = snap.lists[0].cards[0];
    assert.equal(pubCard.title, 'Visible card');
    assert.equal(pubCard.due_date, '2026-09-01');
    assert.deepEqual(pubCard.labels, [{ name: 'Urgent', color: '#ef4444' }]);
    assert.equal(pubCard.checklists[0].items[0].text, 'Do the thing');
    assert.equal(snap.labels.length, 1);

    const raw = JSON.stringify(snap);
    assert(!raw.includes('private-discussion-marker'), 'comments never leak');
    assert(!raw.includes('archived-marker'), 'archived cards never leak');
    assert(!raw.includes('share-a-'), 'owner email never leaks');
    for (const banned of ['id', 'uid', 'owner_id', 'created_at', 'comments', 'attachments', 'activity']) {
      assert(!(banned in snap.board), `board.${banned} not exposed`);
    }
    assert(!('id' in pubCard) && !('uid' in pubCard), 'card ids/uids not exposed');
    ok('public snapshot returns exactly the safe fields');

    // ---- revoke / unknown → 404 ----
    r = await A.api('DELETE', `/api/share/${link.id}`);
    assert.equal(r.json.ok, true);
    r = await anon.api('GET', `/api/share/${link.token}`);
    assert.equal(r.status, 404, 'revoked link is gone');
    r = await anon.api('GET', `/api/share/${'0'.repeat(32)}`);
    assert.equal(r.status, 404, 'unknown token 404s');
    r = await anon.api('GET', '/api/share/not-a-token');
    assert.equal(r.status, 404, 'malformed token 404s');
    ok('revoked, unknown and malformed tokens all 404');

    console.log(`\nAll ${pass} share-link checks passed.`);
  } finally {
    listener.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('\nSHARE TEST FAILED:', e);
  process.exit(1);
});
