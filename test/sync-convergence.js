// Cloud-sync convergence test (sync phase 5). Boots the REAL sync server
// (sync-server/) plus full Boardly app instances (server/app.js createApp on
// port 0, temp data dirs, real REST + session cookies) and simulates
// realistic concurrent usage: conflicting edits, reorders, delete-vs-edit,
// board delete vs card add, attachments end-to-end, a late-joining third
// device and a second account. Proves the devices' local databases converge
// to identical content with nothing lost.
//
// Unlike test/sync-engine.js (two bare DBs driven directly), every mutation
// here goes through the real HTTP API; the sync engines are only used for
// configure/syncNow. Run: node test/sync-convergence.js
//
// Windows timing note: SQLite's clock ticks at ~15.6ms, so any stamp whose
// ORDER matters is set explicitly via nextStamp()/forceStamp() — never
// inferred from ms sleeps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { createApp } = require('../server/app.js');
const { createApp: createSyncServer } = require('../sync-server/app.js');
const { withTrackingSuppressed, getSyncMeta } = require('../server/sync/track.js');

const DEV_KEY = 'sync-convergence-dev-key';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`ok - ${name}`);
}

const tempDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-conv-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Explicit stamp control. Any stamp whose ORDER matters comes from here:
// strictly monotonic and strictly ahead of the issuing database's own clock
// (SQLite's subsec clock can run a few ms ahead of Date.now() on Windows, so
// the DB clock — not the JS clock — is the reference). Deterministic
// regardless of the ~15.6ms tick.
let stampFloor = 0;
function nextStamp(db) {
  const dbNow = db.prepare(`SELECT CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER) AS t`).get().t;
  stampFloor = Math.max(stampFloor + 1, dbNow + 1);
  return stampFloor;
}

// Wait until the DB clock passes `prev` (pattern from test/sync-engine.js —
// the clock may tick at ~15.6ms on Windows).
function waitTick(db, prev) {
  const stmt = db.prepare(`SELECT CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER) AS t`);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (stmt.get().t > prev) return;
  }
  throw new Error('DB clock did not tick');
}

// After each round, wait out each device's push watermark, so the next batch
// of REST writes is stamped STRICTLY above it. A same-ms write would silently
// not push (push selects updated_at > last_push_at), and a create-then-delete
// tie on the server is decided by push order — both destroy determinism.
function waitPastPush(client) {
  waitTick(client.db, Number(getSyncMeta(client.db, 'last_push_at') || 0));
}

function forceStamp(db, table, uuid) {
  withTrackingSuppressed(db, () => {
    db.prepare(`UPDATE ${table} SET updated_at = ? WHERE uuid = ?`).run(nextStamp(db), uuid);
  });
}

// Same, for every card in a list (reorder scenarios dirty the whole list).
function forceListCardStamps(db, listUuid) {
  withTrackingSuppressed(db, () => {
    db.prepare(
      'UPDATE cards SET updated_at = ? WHERE list_id = (SELECT id FROM lists WHERE uuid = ?)'
    ).run(nextStamp(db), listUuid);
  });
}

// Make a just-created set of tombstones unambiguously newer than any stamp
// the server may hold for those rows (and newer than the push watermark, so
// they are actually sent).
function bumpTombstones(db) {
  db.prepare('UPDATE tombstones SET deleted_at = ?').run(nextStamp(db));
}

function byUuid(db, table, uuid) {
  return db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid);
}

// ---- boot helpers ----

async function listen(app) {
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  return listener;
}

async function bootSyncServer() {
  const dataDir = tmpDir();
  const app = createSyncServer({ dataDir, devBootstrapKey: DEV_KEY });
  const listener = await listen(app);
  const url = `http://127.0.0.1:${listener.address().port}`;
  async function mintToken(email) {
    const res = await fetch(`${url}/dev/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-key': DEV_KEY },
      body: JSON.stringify({ email }),
    });
    assert.strictEqual(res.status, 200, 'dev bootstrap should succeed');
    return (await res.json()).token;
  }
  return { url, listener, mintToken };
}

const clients = [];
async function bootClient(name, serverUrl, token) {
  const dataDir = tmpDir();
  const app = createApp({ dataDir, adminPassword: 'admin' });
  // Drive syncNow() manually; the engine's 30s interval would make the test
  // non-deterministic.
  app.stopSync();
  const listener = await listen(app);
  const base = `http://127.0.0.1:${listener.address().port}`;

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  });
  assert.strictEqual(login.status, 200, `${name} login should succeed`);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  async function api(method, urlPath, body, opts = {}) {
    const headers = { cookie };
    let payload;
    if (body instanceof FormData) {
      payload = body; // fetch sets the multipart boundary itself
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + urlPath, { method, headers, body: payload });
    if (opts.raw) return res;
    const json = await res.json();
    assert.ok(res.ok, `${name} ${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  const engine = app.syncEngine;
  if (token) engine.configure({ serverUrl, token });

  const client = {
    name,
    app,
    db: app.db, // exposed by createApp as a test hook
    uploadsDir: path.join(dataDir, 'uploads'),
    listener,
    api,
    engine,
  };
  clients.push(client);
  return client;
}

// One full propagation round: A pushes/pulls, B pushes/pulls, A pulls back.
async function syncRound(a, b) {
  for (const c of [a, b, a]) {
    const res = await c.engine.syncNow();
    assert.ok(res, `${c.name} syncNow failed: ${c.engine.status().lastError}`);
  }
  // Wait out each device's push watermark, so the next batch of REST writes
  // is stamped strictly above it even on Windows' coarse clock.
  waitPastPush(a);
  waitPastPush(b);
}

// ---- canonical dump ----
// All sync-relevant state, keyed by uuid, FKs mapped to parent uuids, local
// ids / filenames / updated_at / sync-meta dropped. created_at is only kept
// for comments and attachments — it's part of their sync payload; for other
// tables it never leaves the origin device, so comparing it would be wrong.
// Attachment FILE bytes are hashed per attachment uuid.
function dumpNormalized(client) {
  const { db, uploadsDir } = client;
  const u = (table, id) => {
    const row = db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id);
    return row ? row.uuid : null;
  };
  const all = (t) => db.prepare(`SELECT * FROM ${t}`).all();
  const dump = {
    boards: all('boards').map((r) => ({
      uuid: r.uuid, name: r.name, description: r.description,
      color: r.color, emoji: r.emoji, starred: r.starred,
    })),
    lists: all('lists').map((r) => ({
      uuid: r.uuid, board: u('boards', r.board_id), name: r.name,
      position: r.position, archived: r.archived,
    })),
    cards: all('cards').map((r) => ({
      uuid: r.uuid, list: u('lists', r.list_id), title: r.title,
      description: r.description, position: r.position,
      due_date: r.due_date, archived: r.archived,
    })),
    labels: all('labels').map((r) => ({
      uuid: r.uuid, board: u('boards', r.board_id), name: r.name, color: r.color,
    })),
    card_labels: all('card_labels').map((r) => ({
      uuid: r.uuid, card: u('cards', r.card_id), label: u('labels', r.label_id),
    })),
    checklists: all('checklists').map((r) => ({
      uuid: r.uuid, card: u('cards', r.card_id), title: r.title, position: r.position,
    })),
    checklist_items: all('checklist_items').map((r) => ({
      uuid: r.uuid, checklist: u('checklists', r.checklist_id), text: r.text,
      done: r.done, position: r.position,
    })),
    comments: all('comments').map((r) => ({
      uuid: r.uuid, card: u('cards', r.card_id), author: r.author,
      body: r.body, created_at: r.created_at,
    })),
    attachments: all('attachments').map((r) => ({
      uuid: r.uuid, card: u('cards', r.card_id), original_name: r.original_name,
      size: r.size, mime: r.mime, created_at: r.created_at,
    })),
    attachment_files: {},
  };
  for (const r of all('attachments')) {
    const file = path.join(uploadsDir, r.filename);
    dump.attachment_files[r.uuid] = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
  }
  for (const key of Object.keys(dump)) {
    if (Array.isArray(dump[key])) dump[key].sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
  }
  return dump;
}

// Both devices converged to byte-identical logical state.
function assertConverged(a, b, label) {
  assert.deepStrictEqual(dumpNormalized(a), dumpNormalized(b), `${label}: dumps differ`);
  ok(`${label}: device dumps are deep-identical`, true);
}

function childrenOf(db, cardUuid) {
  const cid = (byUuid(db, 'cards', cardUuid) || { id: -1 }).id;
  const n = (sql) => db.prepare(sql).get(cid).n;
  return {
    comments: n('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?'),
    checklists: n('SELECT COUNT(*) AS n FROM checklists WHERE card_id = ?'),
    items: n(`SELECT COUNT(*) AS n FROM checklist_items i
              JOIN checklists c ON c.id = i.checklist_id WHERE c.card_id = ?`),
  };
}

async function main() {
  const server = await bootSyncServer();
  const token = await server.mintToken('convergence@example.com');
  ok('sync server booted with dev-bootstrapped token', typeof token === 'string' && token.length === 64);

  const A = await bootClient('A', server.url, token);
  const B = await bootClient('B', server.url, token);
  ok('two full Boardly apps booted, logged in, sync configured', !!(A.db && B.db && A.engine && B.engine));

  try {
    // ================= SCENARIO 1: basic replication via REST =================
    const board = await A.api('POST', '/api/boards', { name: 'Galaxy', color: '#123456', emoji: '🚀' });
    const list = await A.api('POST', `/api/boards/${board.id}/lists`, { name: 'Todo' });
    const cardX = await A.api('POST', `/api/lists/${list.id}/cards`, {
      title: 'Write convergence tests', description: 'phase 5',
    });
    ok('s1: A created board/list/card via REST', !!(board.uuid && list.uuid && cardX.uuid));

    await syncRound(A, B);

    const bBoards = await B.api('GET', '/api/boards');
    const bBoard = bBoards.find((x) => x.uuid === board.uuid);
    ok('s1: board visible on B via REST with same content',
      !!bBoard && bBoard.name === 'Galaxy' && bBoard.emoji === '🚀' && bBoard.color === '#123456');
    const bFull = await B.api('GET', `/api/boards/${bBoard.id}`);
    ok('s1: list + card visible on B via REST with same content',
      bFull.lists.length === 1 && bFull.lists[0].uuid === list.uuid &&
      bFull.lists[0].name === 'Todo' &&
      bFull.lists[0].cards.length === 1 &&
      bFull.lists[0].cards[0].title === 'Write convergence tests' &&
      bFull.lists[0].cards[0].description === 'phase 5');

    // ================= SCENARIO 2: concurrent edits, same card (per-entity LWW) =================
    await A.api('PATCH', `/api/cards/${cardX.id}`, { title: 'Title edited by A' });
    const bCardX = byUuid(B.db, 'cards', cardX.uuid);
    await B.api('PATCH', `/api/cards/${bCardX.id}`, { description: 'Description edited by B' });
    // Per-entity LWW needs a defined winner regardless of wall-clock ticks:
    // force B's stamp strictly newer than A's.
    forceStamp(A.db, 'cards', cardX.uuid); // loser
    forceStamp(B.db, 'cards', cardX.uuid); // winner

    await syncRound(A, B);

    // The card is ONE entity, so B's newer row wins wholesale: B's description
    // edit survives; A's title edit is discarded (documented per-entity LWW —
    // the server tie-break would decide a same-tick collision instead, and
    // either way the winner is one device's full row, never a field merge).
    const xA = byUuid(A.db, 'cards', cardX.uuid);
    const xB = byUuid(B.db, 'cards', cardX.uuid);
    ok('s2: both devices converged on B\'s newer version of the card',
      xA.title === 'Write convergence tests' && xA.description === 'Description edited by B' &&
      xB.title === xA.title && xB.description === xA.description);
    ok('s2: surviving card is exactly one device\'s edit, not a corrupt merge',
      (xA.title === 'Write convergence tests' && xA.description === 'Description edited by B') ||
      (xA.title === 'Title edited by A' && xA.description === 'phase 5'));
    assertConverged(A, B, 's2');

    // ================= SCENARIO 3: concurrent edits, different cards =================
    const c1 = await A.api('POST', `/api/lists/${list.id}/cards`, { title: 'Card one' });
    const c2 = await A.api('POST', `/api/lists/${list.id}/cards`, { title: 'Card two' });
    // Give c1 a comment + checklist + a label for the later cascade test and
    // to exercise those tables end-to-end.
    await A.api('POST', `/api/cards/${c1.id}/comments`, { author: 'A', body: 'first!' });
    const cl1 = await A.api('POST', `/api/cards/${c1.id}/checklists`, { title: 'Steps' });
    await A.api('POST', `/api/checklists/${cl1.id}/items`, { text: 'step 1' });
    const label = await A.api('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' });
    await A.api('POST', `/api/cards/${c1.id}/labels/${label.id}`);
    await syncRound(A, B);
    ok('s3: comment/checklist/item/label replicated to B',
      byUuid(B.db, 'comments', (await A.api('GET', `/api/cards/${c1.id}`)).comments[0].uuid) &&
      childrenOf(B.db, c1.uuid).checklists === 1 &&
      childrenOf(B.db, c1.uuid).items === 1 &&
      byUuid(B.db, 'labels', label.uuid));

    // Both devices edit DIFFERENT cards in the same list before any sync —
    // the user's core requirement: neither edit may be lost.
    await A.api('PATCH', `/api/cards/${c1.id}`, { title: 'Card one (edited by A)' });
    const bC2 = byUuid(B.db, 'cards', c2.uuid);
    await B.api('PATCH', `/api/cards/${bC2.id}`, { title: 'Card two (edited by B)' });

    await syncRound(A, B);

    ok('s3: A\'s edit survived on both devices',
      byUuid(A.db, 'cards', c1.uuid).title === 'Card one (edited by A)' &&
      byUuid(B.db, 'cards', c1.uuid).title === 'Card one (edited by A)');
    ok('s3: B\'s edit survived on both devices',
      byUuid(A.db, 'cards', c2.uuid).title === 'Card two (edited by B)' &&
      byUuid(B.db, 'cards', c2.uuid).title === 'Card two (edited by B)');
    assertConverged(A, B, 's3');

    // ================= SCENARIO 4: concurrent reorders =================
    // List order on both devices: [X, C1, C2] at positions 0,1,2.
    await A.api('POST', `/api/cards/${cardX.id}/move`, { list_id: list.id, position: 2 }); // A: [C1, C2, X]
    const bList = byUuid(B.db, 'lists', list.uuid);
    await B.api('POST', `/api/cards/${bC2.id}/move`, { list_id: bList.id, position: 0 }); // B: [C2, X, C1]
    // The move route renumbers (and dirties) every card in the list, so this
    // is a 3-way per-entity conflict. Force a strict winner: B's view is newer.
    forceListCardStamps(A.db, list.uuid);
    forceListCardStamps(B.db, list.uuid);

    await syncRound(A, B);

    const orderOf = (db) => db.prepare(
      `SELECT c.title FROM cards c JOIN lists l ON l.id = c.list_id
       WHERE l.uuid = ? ORDER BY c.position`
    ).all(list.uuid).map((r) => r.title);
    const expectedOrder = ['Card two (edited by B)', 'Write convergence tests', 'Card one (edited by A)'];
    ok('s4: both devices converged on B\'s (newer) ordering',
      orderOf(A.db).join('|') === expectedOrder.join('|') &&
      orderOf(B.db).join('|') === expectedOrder.join('|'));
    const positionsOf = (db) => db.prepare(
      `SELECT c.position FROM cards c JOIN lists l ON l.id = c.list_id
       WHERE l.uuid = ? ORDER BY c.position`
    ).all(list.uuid).map((r) => r.position);
    ok('s4: positions are dense 0..n on both devices',
      positionsOf(A.db).join(',') === '0,1,2' && positionsOf(B.db).join(',') === '0,1,2');
    assertConverged(A, B, 's4');

    // ================= SCENARIO 5: delete vs edit (resurrection) =================
    await A.api('DELETE', `/api/cards/${c1.id}`);
    // The server holds C1 at scenario 4's forced (future) stamp; make A's
    // delete unambiguously newer than that, or the server would reject it.
    bumpTombstones(A.db);
    const bC1 = byUuid(B.db, 'cards', c1.uuid);
    await B.api('PATCH', `/api/cards/${bC1.id}`, { title: 'Card one (resurrected by B)' });
    // B's edit must beat A's delete — force it strictly newer than the tombstone.
    forceStamp(B.db, 'cards', c1.uuid);

    await syncRound(A, B);

    ok('s5: delete vs newer edit — card survives on both with B\'s title',
      byUuid(A.db, 'cards', c1.uuid) && byUuid(B.db, 'cards', c1.uuid) &&
      byUuid(A.db, 'cards', c1.uuid).title === 'Card one (resurrected by B)' &&
      byUuid(B.db, 'cards', c1.uuid).title === 'Card one (resurrected by B)');
    // Resurrection is per-ENTITY, not per-subtree: nobody edited c1's
    // comment/checklist/item or its card_labels join row, so A's valid
    // tombstones for them won everywhere. The label itself survives — it
    // belongs to the board, not the card.
    const s5ChildrenA = childrenOf(A.db, c1.uuid);
    const s5ChildrenB = childrenOf(B.db, c1.uuid);
    ok('s5: unedited children of the deleted card stay deleted on both (per-entity semantics)',
      s5ChildrenA.comments === 0 && s5ChildrenA.checklists === 0 && s5ChildrenA.items === 0 &&
      s5ChildrenB.comments === 0 && s5ChildrenB.checklists === 0 && s5ChildrenB.items === 0);
    assertConverged(A, B, 's5 (resurrection)');

    // Fresh children, synced to both, then a clean delete with no concurrent
    // edit: the card and everything hanging off it must disappear on both.
    const bC1b = byUuid(B.db, 'cards', c1.uuid);
    await B.api('POST', `/api/cards/${bC1b.id}/comments`, { author: 'B', body: 'about to die' });
    const clB = await B.api('POST', `/api/cards/${bC1b.id}/checklists`, { title: 'Doomed' });
    await B.api('POST', `/api/checklists/${clB.id}/items`, { text: 'doomed step' });
    await syncRound(A, B);
    ok('s5: fresh comment/checklist/item present on both before delete',
      childrenOf(A.db, c1.uuid).comments === 1 && childrenOf(A.db, c1.uuid).checklists === 1 &&
      childrenOf(A.db, c1.uuid).items === 1 && childrenOf(B.db, c1.uuid).comments === 1);

    await B.api('DELETE', `/api/cards/${bC1b.id}`);
    // Beat the forced resurrection stamp the server holds for the card.
    bumpTombstones(B.db);
    await syncRound(A, B);

    ok('s5: clean delete removes the card on both devices',
      !byUuid(A.db, 'cards', c1.uuid) && !byUuid(B.db, 'cards', c1.uuid));
    ok('s5: comments/checklists/items cascaded away on both devices',
      childrenOf(A.db, c1.uuid).comments === 0 && childrenOf(A.db, c1.uuid).checklists === 0 &&
      childrenOf(A.db, c1.uuid).items === 0 && childrenOf(B.db, c1.uuid).comments === 0 &&
      childrenOf(B.db, c1.uuid).checklists === 0 && childrenOf(B.db, c1.uuid).items === 0);
    assertConverged(A, B, 's5 (clean delete)');

    // ================= SCENARIO 6: board delete while other device adds a card =================
    const board2 = await A.api('POST', '/api/boards', { name: 'Ephemeral' });
    const list2 = await A.api('POST', `/api/boards/${board2.id}/lists`, { name: 'Temp' });
    await syncRound(A, B);

    await A.api('DELETE', `/api/boards/${board2.id}`);
    const bList2 = byUuid(B.db, 'lists', list2.uuid);
    const orphan = await B.api('POST', `/api/lists/${bList2.id}/cards`, { title: 'Orphan card' });

    await syncRound(A, B);

    // Semantics: the container delete wins over edits inside it. B's card
    // pushes fine (the server stores opaque rows), but once B applies the
    // board/list tombstones its FK cascade removes the card locally, and on
    // A the pulled card's parent list no longer resolves, so it is skipped
    // as an orphan of a remotely deleted subtree. Net: gone everywhere.
    ok('s6: deleted board gone on both devices',
      !byUuid(A.db, 'boards', board2.uuid) && !byUuid(B.db, 'boards', board2.uuid));
    ok('s6: orphaned card (added concurrently on B) gone on both devices',
      !byUuid(A.db, 'cards', orphan.uuid) && !byUuid(B.db, 'cards', orphan.uuid) &&
      !byUuid(A.db, 'lists', list2.uuid) && !byUuid(B.db, 'lists', list2.uuid));
    assertConverged(A, B, 's6');

    // ================= SCENARIO 7: attachments end-to-end =================
    // A adds a card + real file; B adds a different card + different file —
    // all before any sync (concurrent).
    const cardAttA = await A.api('POST', `/api/lists/${list.id}/cards`, { title: 'Attachment from A' });
    const bytesA = Buffer.from(`attachment-bytes-A-${Date.now()}-\x00\x01\x02` + 'x'.repeat(64));
    const formA = new FormData();
    formA.append('file', new Blob([bytesA], { type: 'text/plain' }), 'alpha.txt');
    const attA = await A.api('POST', `/api/cards/${cardAttA.id}/attachments`, formA);

    const bList1 = byUuid(B.db, 'lists', list.uuid);
    const cardAttB = await B.api('POST', `/api/lists/${bList1.id}/cards`, { title: 'Attachment from B' });
    const bytesB = Buffer.from(`attachment-bytes-B-${Date.now()}-\x03\x04\x05` + 'y'.repeat(64));
    const formB = new FormData();
    formB.append('file', new Blob([bytesB], { type: 'text/plain' }), 'beta.txt');
    const attB = await B.api('POST', `/api/cards/${cardAttB.id}/attachments`, formB);

    await syncRound(A, B);

    for (const [client, att, bytes, tag] of [
      [A, attA, bytesA, 'A\u2192A'], [A, attB, bytesB, 'B\u2192A'],
      [B, attA, bytesA, 'A\u2192B'], [B, attB, bytesB, 'B\u2192B'],
    ]) {
      const row = byUuid(client.db, 'attachments', att.uuid);
      ok(`s7: attachment row present on ${client.name} (${tag})`, !!row);
      const onDisk = fs.readFileSync(path.join(client.uploadsDir, row.filename));
      ok(`s7: attachment bytes identical on ${client.name} (${tag})`, onDisk.equals(bytes));
      const served = await client.api('GET', `/uploads/${row.filename}`, undefined, { raw: true });
      const servedBytes = Buffer.from(await served.arrayBuffer());
      ok(`s7: REST /uploads serves identical bytes on ${client.name} (${tag})`,
        served.status === 200 && servedBytes.equals(bytes));
    }
    assertConverged(A, B, 's7');

    // ================= SCENARIO 8: late-joining third device =================
    const C = await bootClient('C', server.url, token);
    const resC = await C.engine.syncNow();
    assert.ok(resC, `C syncNow failed: ${C.engine.status().lastError}`);
    // C pulled the full account history (including tombstones and the orphan
    // card from s6, which it must skip) and should land exactly on A's state.
    // Activity is local-only by design and excluded from the dump; comments
    // DO sync and are compared.
    assert.deepStrictEqual(dumpNormalized(C), dumpNormalized(A),
      's8: late-joining device state differs from A');
    ok('s8: late-joining third device converges to the full current state', true);

    // ================= SCENARIO 9: final deep convergence =================
    await syncRound(A, B);
    const dumpA = dumpNormalized(A);
    const dumpB = dumpNormalized(B);
    assert.deepStrictEqual(dumpA, dumpB, 's9: final dumps differ');
    ok('s9: final dumps of A and B are deep-identical', true);
    ok('s9: sync did not nuke everything (boards/cards/attachments remain)',
      dumpA.boards.length >= 1 && dumpA.cards.length >= 1 &&
      dumpA.attachments.length === 2 && dumpA.comments.length >= 0);

    // ================= SCENARIO 10: auth isolation =================
    const token2 = await server.mintToken('other-account@example.com');
    const D = await bootClient('D', server.url, token2);
    const resD = await D.engine.syncNow();
    assert.ok(resD, `D syncNow failed: ${D.engine.status().lastError}`);
    const dumpD = dumpNormalized(D);
    ok('s10: second account pulled zero of account 1\'s changes', resD.pulled === 0);
    ok('s10: second account sees none of account 1\'s boards',
      dumpD.boards.length === 0 && dumpD.lists.length === 0 && dumpD.cards.length === 0);
    const dBoards = await D.api('GET', '/api/boards');
    ok('s10: second account\'s REST board list is empty',
      Array.isArray(dBoards) && dBoards.length === 0);

    console.log(`\n${passed} assertions passed`);
  } finally {
    for (const c of clients) {
      try { c.app.stopSync(); } catch {}
      try { c.listener.close(); } catch {}
      try { c.db.close(); } catch {}
    }
    try { server.listener.close(); } catch {}
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
  });
