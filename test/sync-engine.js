// Sync engine (sync phase 3) end-to-end tests. Boots the REAL sync-server
// (phase 2) on a temp dir with a dev-bootstrap token, then drives two client
// DBs + two engines through replication, LWW conflicts, tombstones,
// resurrection, attachment transfer, position normalization and disable.
// The real Boardly DB is never touched. Run: node test/sync-engine.js
//
// Timing note: SQLite's clock may tick at ~15.6ms on Windows, so stamps that
// must be ordered are always separated by waitTick() — never by ms-sleeps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { openDb } = require('../server/db');
const { createSyncEngine } = require('../server/sync/engine');
const { getSyncMeta } = require('../server/sync/track');
const { createApp: createSyncServer } = require('../sync-server/app');

const DEV_KEY = 'sync-engine-test-dev-key';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-synceng-'));
}

// Wait until the DB clock actually passes `prev` (see header note).
function waitTick(db, prev) {
  const stmt = db.prepare(`SELECT CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER) AS t`);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (stmt.get().t > prev) return;
  }
  throw new Error('DB clock did not tick');
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`ok - ${name}`);
}

async function main() {
  // ---- sync server (phase 2, unmodified) with a dev-bootstrapped account ----
  const srvDir = tmpDir();
  const srvApp = createSyncServer({ dataDir: srvDir, devBootstrapKey: DEV_KEY });
  const srvListener = srvApp.listen(0, '127.0.0.1');
  await new Promise((r) => srvListener.once('listening', r));
  const serverUrl = `http://127.0.0.1:${srvListener.address().port}`;

  const boot = await fetch(`${serverUrl}/dev/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-key': DEV_KEY },
    body: JSON.stringify({ email: 'sync-test@example.com' }),
  });
  assert.strictEqual(boot.status, 200, 'dev bootstrap should succeed');
  const { token } = await boot.json();
  ok('sync server bootstrapped with token', typeof token === 'string' && token.length === 64);

  // ---- two devices: separate data dirs, DBs, uploads dirs, engines ----
  const dirA = tmpDir();
  const dirB = tmpDir();
  const dbA = openDb(dirA);
  const dbB = openDb(dirB);
  const uploadsDirA = path.join(dirA, 'uploads');
  const uploadsDirB = path.join(dirB, 'uploads');
  const engineA = createSyncEngine({ db: dbA, uploadsDir: uploadsDirA });
  const engineB = createSyncEngine({ db: dbB, uploadsDir: uploadsDirB });
  engineA.configure({ serverUrl, token });
  engineB.configure({ serverUrl, token });

  // 1+2. Device A creates board + list + card; push is accepted.
  dbA.prepare(`INSERT INTO boards (name) VALUES ('Roadmap')`).run();
  const bA = dbA.prepare(`SELECT * FROM boards WHERE name = 'Roadmap'`).get();
  dbA.prepare(`INSERT INTO lists (board_id, name) VALUES (?, 'Todo')`).run(bA.id);
  const lA = dbA.prepare(`SELECT * FROM lists WHERE board_id = ?`).get(bA.id);
  dbA.prepare(`INSERT INTO cards (list_id, title) VALUES (?, 'Write tests')`).run(lA.id);
  const cA = dbA.prepare(`SELECT * FROM cards WHERE list_id = ?`).get(lA.id);

  const resA = await engineA.syncNow();
  ok('device A push accepted changes', resA && resA.accepted >= 3);

  // 3. Device B pulls: same uuids, FKs resolved to B's local ids.
  const resB = await engineB.syncNow();
  ok('device B pulled changes', resB && resB.pulled >= 3);
  const bB = dbB.prepare('SELECT * FROM boards WHERE uuid = ?').get(bA.uuid);
  ok('board replicated with same uuid', !!bB && bB.name === 'Roadmap');
  const lB = dbB.prepare('SELECT * FROM lists WHERE uuid = ?').get(lA.uuid);
  ok('list replicated with resolved board FK', !!lB && lB.board_id === bB.id);
  const cB = dbB.prepare('SELECT * FROM cards WHERE uuid = ?').get(cA.uuid);
  ok('card replicated with resolved list FK', !!cB && cB.list_id === lB.id);

  // 4. LWW conflict: A edits at T1, B edits later at T2 > T1; B must win everywhere.
  dbA.prepare(`UPDATE cards SET title = 'Title from A' WHERE id = ?`).run(cA.id);
  const stampA = dbA.prepare('SELECT updated_at FROM cards WHERE id = ?').get(cA.id).updated_at;
  waitTick(dbB, stampA);
  dbB.prepare(`UPDATE cards SET title = 'Title from B' WHERE id = ?`).run(cB.id);
  await engineA.syncNow(); // A pushes T1
  await engineB.syncNow(); // B pushes T2 (wins on server), pulls T1 (stale → no-op)
  await engineA.syncNow(); // A pulls T2
  const titleA = dbA.prepare('SELECT title FROM cards WHERE id = ?').get(cA.id).title;
  const titleB = dbB.prepare('SELECT title FROM cards WHERE id = ?').get(cB.id).title;
  ok('LWW: both devices agree on the newer title', titleA === 'Title from B' && titleB === 'Title from B');

  // 5. Tombstone: A deletes the card; it disappears on B; A prunes the tombstone.
  waitTick(dbA, Number(getSyncMeta(dbA, 'last_push_at')));
  dbA.prepare('DELETE FROM cards WHERE id = ?').run(cA.id);
  const resTomb = await engineA.syncNow();
  ok('tombstone pushed', resTomb && resTomb.accepted >= 1);
  const tombsA = dbA.prepare('SELECT * FROM tombstones').all();
  ok('tombstones pruned on A after push', tombsA.length === 0);
  await engineB.syncNow();
  ok('card deleted on B via tombstone', !dbB.prepare('SELECT * FROM cards WHERE uuid = ?').get(cA.uuid));

  // 6. Resurrection: A pushes a delete of the list (older stamp), B has a
  // newer local edit — the list survives on both devices.
  waitTick(dbA, Number(getSyncMeta(dbA, 'last_push_at')));
  dbA.prepare('DELETE FROM lists WHERE id = ?').run(lA.id);
  const tDel = dbA.prepare('SELECT deleted_at FROM tombstones WHERE uuid = ?').get(lA.uuid).deleted_at;
  waitTick(dbB, tDel);
  dbB.prepare(`UPDATE lists SET name = 'Todo (renamed)' WHERE id = ?`).run(lB.id);
  await engineA.syncNow(); // A pushes the (older) tombstone
  await engineB.syncNow(); // B pushes the newer rename, ignores the stale tombstone
  await engineA.syncNow(); // A pulls the rename → list re-created locally
  const lA2 = dbA.prepare('SELECT * FROM lists WHERE uuid = ?').get(lA.uuid);
  const lB2 = dbB.prepare('SELECT * FROM lists WHERE uuid = ?').get(lA.uuid);
  ok('resurrection: list survives on both devices', !!lA2 && !!lB2);
  ok('resurrection: newer rename wins on both',
    lA2.name === 'Todo (renamed)' && lB2.name === 'Todo (renamed)');
  ok('resurrected list keeps resolved board FK', lA2.board_id === bA.id);

  // 7. Attachment: row + bytes travel; B stores them under <uuid><ext>.
  waitTick(dbA, Number(getSyncMeta(dbA, 'last_push_at')));
  const c2Id = dbA.prepare(`INSERT INTO cards (list_id, title) VALUES (?, 'With attachment')`)
    .run(lA2.id).lastInsertRowid;
  const cA2 = dbA.prepare('SELECT * FROM cards WHERE id = ?').get(c2Id);
  const fileBytes = Buffer.from('hello sync attachment\n');
  fs.writeFileSync(path.join(uploadsDirA, 'local-file.txt'), fileBytes);
  dbA.prepare(
    `INSERT INTO attachments (card_id, filename, original_name, size, mime)
     VALUES (?, 'local-file.txt', 'notes.txt', ?, 'text/plain')`
  ).run(c2Id, fileBytes.length);
  const attA = dbA.prepare('SELECT * FROM attachments WHERE card_id = ?').get(c2Id);

  const resAtt = await engineA.syncNow();
  ok('attachment push accepted (row + card)', resAtt && resAtt.accepted >= 2);
  await engineB.syncNow();
  const attB = dbB.prepare('SELECT * FROM attachments WHERE uuid = ?').get(attA.uuid);
  ok('attachment row replicated', !!attB && attB.original_name === 'notes.txt');
  const cB2 = dbB.prepare('SELECT * FROM cards WHERE uuid = ?').get(cA2.uuid);
  ok('attachment FK resolved on B', attB.card_id === cB2.id);
  ok('attachment filename is uuid-based, not the origin name',
    attB.filename === `${attA.uuid}.txt`);
  const bufB = fs.readFileSync(path.join(uploadsDirB, attB.filename));
  ok('attachment bytes identical on B', bufB.equals(fileBytes));

  // 8. Position normalize: duplicate positions (5, 5) converge to dense (1, 2)
  // ordered by updated_at. (The earlier card keeps position 0.)
  waitTick(dbA, Number(getSyncMeta(dbA, 'last_push_at')));
  const p1Id = dbA.prepare(`INSERT INTO cards (list_id, title) VALUES (?, 'P1')`)
    .run(lA2.id).lastInsertRowid;
  const p1Stamp = dbA.prepare('SELECT updated_at FROM cards WHERE id = ?').get(p1Id).updated_at;
  waitTick(dbA, p1Stamp);
  const p2Id = dbA.prepare(`INSERT INTO cards (list_id, title) VALUES (?, 'P2')`)
    .run(lA2.id).lastInsertRowid;
  dbA.prepare('UPDATE cards SET position = 5 WHERE id = ?').run(p1Id);
  const p1Upd = dbA.prepare('SELECT updated_at FROM cards WHERE id = ?').get(p1Id).updated_at;
  waitTick(dbA, p1Upd);
  dbA.prepare('UPDATE cards SET position = 5 WHERE id = ?').run(p2Id);
  const p1 = dbA.prepare('SELECT * FROM cards WHERE id = ?').get(p1Id);
  const p2 = dbA.prepare('SELECT * FROM cards WHERE id = ?').get(p2Id);
  await engineA.syncNow();
  await engineB.syncNow();
  const p1B = dbB.prepare('SELECT * FROM cards WHERE uuid = ?').get(p1.uuid);
  const p2B = dbB.prepare('SELECT * FROM cards WHERE uuid = ?').get(p2.uuid);
  ok('positions normalized densely on B', p1B.position === 1 && p2B.position === 2);
  const allPos = dbB.prepare('SELECT position FROM cards WHERE list_id = ? ORDER BY position')
    .all(lB2.id).map((r) => r.position);
  ok('list positions are dense 0..n on B', allPos.join(',') === '0,1,2');

  // 9. Disabled engine: syncNow is a no-op, nothing leaves the device.
  engineB.disable();
  const stB = engineB.status();
  ok('status reports disabled', stB.enabled === false);
  dbB.prepare(`INSERT INTO boards (name) VALUES ('Offline board')`).run();
  const rOff = await engineB.syncNow();
  ok('syncNow is a no-op when disabled', rOff === undefined);
  await engineA.syncNow();
  ok('changes made while disabled stay local',
    !dbA.prepare(`SELECT * FROM boards WHERE name = 'Offline board'`).get());
  ok('status counts pending changes while disabled', engineB.status().pendingChanges >= 1);

  // 10. status() surfaces account info fetched from the sync server.
  const stA = engineA.status();
  ok('status reflects account info from server',
    stA.account && stA.account.active === true && stA.account.status === 'active');
  ok('status has no error after healthy syncs', stA.lastError === null);
  ok('status reports last sync time', typeof stA.lastSyncAt === 'number' && stA.lastSyncAt > 0);

  srvListener.close();
  dbA.close();
  dbB.close();
  console.log(`\n${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
