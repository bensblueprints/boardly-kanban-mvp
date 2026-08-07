// Sync engine test — a real two-sided conversation: a cloud app (SQLite
// store forced into cloud mode, same as test/accounts.js) and a desktop app,
// talking over HTTP through the desktop's sync client. Covers: push, pull,
// LWW in both directions, uid reference resolution with colliding local
// integer ids, card moves, deletes via tombstones in both directions, and
// cascade tombstones for a whole board subtree.
//
// Run: node test/sync.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app');

const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-sync-cloud-'));
const deskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-sync-desk-'));

let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

function client(base) {
  let cookie = '';
  return {
    base,
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
  // ---- boot both sides ----
  // With DATABASE_URL set the cloud side runs on real Postgres (the desktop
  // side stays SQLite — exactly the production topology).
  const cloudOpts = process.env.DATABASE_URL ? { dataDir: cloudDir } : { dataDir: cloudDir, mode: 'cloud' };
  const cloudApp = await createApp(cloudOpts);
  const cloudListener = cloudApp.listen(0, '127.0.0.1');
  await new Promise((r) => cloudListener.once('listening', r));
  const cloud = client(`http://127.0.0.1:${cloudListener.address().port}`);
  const cloudStore = cloudApp.locals.store;

  // databaseUrl: null pins the desktop side to SQLite even when DATABASE_URL
  // is set for the cloud side (see openStore).
  const deskApp = await createApp({ dataDir: deskDir, adminPassword: 'admin', databaseUrl: null });
  const deskListener = deskApp.listen(0, '127.0.0.1');
  await new Promise((r) => deskListener.once('listening', r));
  const desk = client(`http://127.0.0.1:${deskListener.address().port}`);
  const deskStore = deskApp.locals.store;

  const syncNow = async () => (await desk.api('POST', '/api/sync/now')).json;

  try {
    // ---- cloud account + token; a cloud-native board created "offline" ----
    // Unique email per run so the test is re-runnable against a shared
    // Postgres (validation runs reuse a throwaway container).
    const email = `sync-${Date.now()}@test.dev`;
    await cloud.api('POST', '/api/register', { email, password: 'sync-pass-123' });
    const tokenRow = (await cloud.api('POST', '/api/tokens', { name: 'desktop' })).json;
    const token = tokenRow.token;
    const b0 = (await cloud.api('POST', '/api/boards', { name: 'Cloud native' })).json;
    const b0l = (await cloud.api('POST', `/api/boards/${b0.id}/lists`, { name: 'Todo' })).json;
    const b0c = (await cloud.api('POST', `/api/lists/${b0l.id}/cards`, { title: 'Cloud card' })).json;
    await cloud.api('POST', `/api/cards/${b0c.id}/checklists`, { title: 'Steps' });
    ok('cloud account, token, and a cloud-native board (its card holds local id 1)');

    // ---- desktop works offline, then connects ----
    await desk.api('POST', '/api/login', { password: 'admin' });
    const b1 = (await desk.api('POST', '/api/boards', { name: 'Desk board' })).json;
    const b1l = (await desk.api('POST', `/api/boards/${b1.id}/lists`, { name: 'Doing' })).json;
    const b1c = (await desk.api('POST', `/api/lists/${b1l.id}/cards`, { title: 'Desk card' })).json;
    assert.notEqual(b1c.uid, b0c.uid, 'each side assigns its own uid');

    const st = (await desk.api('POST', '/api/sync/connect', { url: cloud.base, token })).json;
    assert.equal(st.configured, true, JSON.stringify(st));
    assert(st.lastSyncAt, 'first sync ran during connect');
    ok('desktop connects with URL + token and syncs immediately');

    // ---- push landed on the cloud, nothing clobbered ----
    const cloudBoards = (await cloud.api('GET', '/api/boards')).json;
    assert.equal(cloudBoards.length, 2, 'cloud has both boards');
    const cloudB1 = cloudBoards.find((b) => b.name === 'Desk board');
    const cloudB1Full = (await cloud.api('GET', `/api/boards/${cloudB1.id}`)).json;
    const pushedCard = cloudB1Full.lists[0].cards[0];
    assert.equal(pushedCard.title, 'Desk card');
    assert.notEqual(pushedCard.id, b1c.id, 'cloud assigned its own integer id — no clobber');
    ok('push: desktop board/list/card appear on the cloud with fresh integer ids');

    // ---- pull: a cloud-side edit lands on the desktop ----
    const cloudCard2 = (await cloud.api('POST', `/api/lists/${cloudB1Full.lists[0].id}/cards`, { title: 'Made in cloud' })).json;
    await syncNow();
    let deskB1 = (await desk.api('GET', `/api/boards/${b1.id}`)).json;
    assert(deskB1.lists[0].cards.some((c) => c.title === 'Made in cloud'), 'cloud card pulled to desktop');
    const deskB0 = (await desk.api('GET', '/api/boards')).json.find((b) => b.name === 'Cloud native');
    assert(deskB0, 'cloud-native board pulled to desktop');
    ok('pull: cloud changes appear on the desktop');

    // ---- LWW, cloud wins ----
    await deskStore.run("UPDATE cards SET updated_at = '2020-01-01 00:00:00' WHERE uid = ?", [pushedCard.uid]);
    await cloud.api('PATCH', `/api/cards/${pushedCard.id}`, { title: 'Cloud edit' });
    await syncNow();
    deskB1 = (await desk.api('GET', `/api/boards/${b1.id}`)).json;
    assert.equal(deskB1.lists.flatMap((l) => l.cards).find((c) => c.uid === pushedCard.uid).title, 'Cloud edit');
    ok('LWW: the newer cloud edit wins on the desktop');

    // ---- LWW, desktop wins ----
    await cloudStore.run("UPDATE cards SET updated_at = '2020-01-01 00:00:00' WHERE uid = ?", [pushedCard.uid]);
    const deskCard = deskB1.lists.flatMap((l) => l.cards).find((c) => c.uid === pushedCard.uid);
    await desk.api('PATCH', `/api/cards/${deskCard.id}`, { title: 'Desk edit' });
    await syncNow();
    const cloudAfter = (await cloud.api('GET', `/api/cards/${pushedCard.id}`)).json;
    assert.equal(cloudAfter.title, 'Desk edit');
    ok('LWW: the newer desktop edit wins on the cloud');

    // ---- move between lists syncs ----
    // Cross the one-second boundary of the updated_at clock first: the "Desk
    // edit" above landed in this same second, and on an exact tie the cloud
    // keeps its row — the move would be a same-second tie and be dropped.
    await new Promise((r) => setTimeout(r, 1100));
    const l2 = (await desk.api('POST', `/api/boards/${b1.id}/lists`, { name: 'Done' })).json;
    await desk.api('POST', `/api/cards/${deskCard.id}/move`, { list_id: l2.id, position: 0 });
    await syncNow();
    const cloudB1Moved = (await cloud.api('GET', `/api/boards/${cloudB1.id}`)).json;
    const doneList = cloudB1Moved.lists.find((l) => l.name === 'Done');
    assert(doneList && doneList.cards.some((c) => c.uid === pushedCard.uid), 'card sits in the new list on the cloud');
    ok('move between lists syncs (reference re-resolution by uid)');

    // ---- delete propagates desktop → cloud ----
    const cloudMadeUid = cloudCard2.uid;
    const deskCloudCard = deskB1.lists.flatMap((l) => l.cards).find((c) => c.title === 'Made in cloud');
    await desk.api('DELETE', `/api/cards/${deskCloudCard.id}`);
    await syncNow();
    const gone = await cloud.api('GET', `/api/cards/${cloudCard2.id}`);
    assert.equal(gone.status, 404, 'deleted card is gone from the cloud');
    ok('delete propagates via tombstone (desktop → cloud)');

    // ---- cascade delete propagates cloud → desktop, with tombstones ----
    await cloud.api('DELETE', `/api/boards/${b0.id}`);
    await syncNow();
    const deskB0Gone = await desk.api('GET', `/api/boards/${deskB0.id}`);
    assert.equal(deskB0Gone.status, 404, 'cloud-deleted board is gone from the desktop');
    const pulled = (await cloud.api('GET', '/api/sync/pull?since=-1')).json;
    const tombTables = new Set(pulled.tombstones.map((t) => t.tbl));
    for (const t of ['boards', 'lists', 'cards', 'checklists']) {
      assert(tombTables.has(t), `tombstones cover ${t}`);
    }
    assert(pulled.tombstones.some((t) => t.tbl === 'boards' && t.uid === b0.uid), 'board tombstone carries the uid');
    ok('cascade delete records tombstones for the whole subtree (cloud → desktop)');

    // ---- status endpoint ----
    const status = (await desk.api('GET', '/api/sync')).json;
    assert.equal(status.configured, true);
    assert.equal(status.state, 'idle');
    assert(status.lastSyncAt);
    ok('sync status reports configured + last sync time');

    console.log(`\nAll ${pass} sync checks passed.`);
  } finally {
    await deskApp.stopSync?.();
    cloudListener.close();
    deskListener.close();
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(deskDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('\nSYNC TEST FAILED:', e);
  process.exit(1);
});
