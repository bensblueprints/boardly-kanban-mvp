// Change-tracking (sync phase 1) tests: uuid/updated_at stamping, tombstones,
// suppression, legacy-DB migration, listLocalChanges.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');
const { openDb } = require('../server/db');
const {
  TRACKED_TABLES,
  withTrackingSuppressed,
  listLocalChanges,
} = require('../server/sync/track');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-track-'));
}

// Windows' legacy timer ticks at ~15.6ms, so SQLite's clock may not advance
// after a 5ms sleep. Wait until the DB clock actually passes `prev`.
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

// 1. fresh DB: insert auto-stamps uuid + updated_at
{
  const dir = tmpDir();
  const db = openDb(dir);
  db.prepare(`INSERT INTO boards (name) VALUES ('B1')`).run();
  const b = db.prepare(`SELECT * FROM boards WHERE name = 'B1'`).get();
  ok('insert stamps uuid', typeof b.uuid === 'string' && b.uuid.length === 36);
  ok('insert stamps updated_at (ms)', b.updated_at > 1e12);
  db.close();
}

// 2. update bumps updated_at
{
  const dir = tmpDir();
  const db = openDb(dir);
  db.prepare(`INSERT INTO boards (name) VALUES ('B2')`).run();
  const before = db.prepare(`SELECT * FROM boards WHERE name = 'B2'`).get();
  waitTick(db, before.updated_at);
  db.prepare(`UPDATE boards SET name = 'B2x' WHERE id = ?`).run(before.id);
  const after = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(before.id);
  ok('update bumps updated_at', after.updated_at > before.updated_at);
  ok('update keeps uuid', after.uuid === before.uuid);
  db.close();
}

// 3. delete writes a tombstone
{
  const dir = tmpDir();
  const db = openDb(dir);
  db.prepare(`INSERT INTO boards (name) VALUES ('B3')`).run();
  const b = db.prepare(`SELECT * FROM boards WHERE name = 'B3'`).get();
  db.prepare(`DELETE FROM boards WHERE id = ?`).run(b.id);
  const t = db.prepare(`SELECT * FROM tombstones WHERE uuid = ?`).get(b.uuid);
  ok('delete writes tombstone', t && t.table_name === 'boards' && t.deleted_at > 1e12);
  db.close();
}

// 4. cascade delete tombstones children too
{
  const dir = tmpDir();
  const db = openDb(dir);
  const bId = db.prepare(`INSERT INTO boards (name) VALUES ('B4')`).run().lastInsertRowid;
  const lId = db.prepare(`INSERT INTO lists (board_id, name) VALUES (?, 'L')`).run(bId).lastInsertRowid;
  const cId = db.prepare(`INSERT INTO cards (list_id, title) VALUES (?, 'C')`).run(lId).lastInsertRowid;
  const b = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(bId);
  const l = db.prepare(`SELECT * FROM lists WHERE id = ?`).get(lId);
  const c = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(cId);
  db.prepare(`DELETE FROM boards WHERE id = ?`).run(b.id);
  const tombs = db.prepare(`SELECT uuid FROM tombstones`).all().map((r) => r.uuid);
  ok('cascade tombstones board+list+card',
    [b.uuid, l.uuid, c.uuid].every((u) => tombs.includes(u)));
  db.close();
}

// 5. suppression: sync-apply writes are not re-tracked
{
  const dir = tmpDir();
  const db = openDb(dir);
  withTrackingSuppressed(db, () => {
    db.prepare(`INSERT INTO boards (name, uuid, updated_at) VALUES ('B5', 'remote-uuid-1', 123)`).run();
  });
  const b = db.prepare(`SELECT * FROM boards WHERE uuid = 'remote-uuid-1'`).get();
  ok('suppressed insert preserves remote uuid/updated_at',
    b && b.updated_at === 123);
  withTrackingSuppressed(db, () => {
    db.prepare(`DELETE FROM boards WHERE uuid = 'remote-uuid-1'`).run();
  });
  const t = db.prepare(`SELECT * FROM tombstones WHERE uuid = 'remote-uuid-1'`).get();
  ok('suppressed delete writes no tombstone', !t);
  db.close();
}

// 6. legacy DB (pre-sync schema) migrates: columns added + backfilled
{
  const dir = tmpDir();
  const legacy = new Database(path.join(dir, 'app.db'));
  legacy.exec(`
    CREATE TABLE boards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#6366f1',
      emoji TEXT NOT NULL DEFAULT '📋', starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE lists (id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO boards (name) VALUES ('Legacy');
    INSERT INTO lists (board_id, name) VALUES (1, 'LegacyList');
  `);
  legacy.close();

  const db = openDb(dir); // runs migrations + installSyncTracking
  const b = db.prepare(`SELECT * FROM boards WHERE name = 'Legacy'`).get();
  const l = db.prepare(`SELECT * FROM lists WHERE name = 'LegacyList'`).get();
  ok('legacy rows backfilled with uuid', b.uuid && l.uuid);
  ok('legacy rows backfilled with updated_at', b.updated_at > 1e12 && l.updated_at > 1e12);
  // triggers now active on the migrated tables
  waitTick(db, b.updated_at);
  db.prepare(`UPDATE boards SET name = 'Legacy2' WHERE id = ?`).run(b.id);
  const b2 = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(b.id);
  ok('migrated tables get stamping triggers', b2.updated_at > b.updated_at);
  db.close();
}

// 7. listLocalChanges: changed rows + tombstones since a watermark
{
  const dir = tmpDir();
  const db = openDb(dir);
  db.prepare(`INSERT INTO boards (name) VALUES ('Old')`).run();
  // watermark = the Old board's own stamp (what the sync engine stores as last_push_at)
  const since = db.prepare(`SELECT updated_at FROM boards WHERE name = 'Old'`).get().updated_at;
  waitTick(db, since);
  db.prepare(`INSERT INTO boards (name) VALUES ('New')`).run();
  const n = db.prepare(`SELECT * FROM boards WHERE name = 'New'`).get();
  db.prepare(`DELETE FROM boards WHERE id = ?`).run(n.id);
  db.prepare(`INSERT INTO labels (board_id, name) VALUES (1, 'lbl')`).run();

  const changes = listLocalChanges(db, since);
  const labelChange = changes.find((c) => c.table === 'labels' && !c.deleted);
  const tomb = changes.find((c) => c.deleted && c.row.uuid === n.uuid);
  ok('listLocalChanges finds new label', !!labelChange);
  ok('listLocalChanges finds tombstone', !!tomb);
  const old = changes.find((c) => !c.deleted && c.row.name === 'Old');
  ok('listLocalChanges excludes rows older than watermark', !old);
  db.close();
}

// 8. every tracked table has uuid + updated_at columns and triggers
{
  const dir = tmpDir();
  const db = openDb(dir);
  for (const t of TRACKED_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    ok(`${t} has uuid+updated_at`, cols.includes('uuid') && cols.includes('updated_at'));
    const trigs = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?`)
      .all(t).map((r) => r.name);
    ok(`${t} has 3 sync triggers`,
      ['sync_insert', 'sync_update', 'sync_delete'].every((s) =>
        trigs.includes(`trg_${t}_${s}`)));
  }
  db.close();
}

console.log(`\n${passed} assertions passed`);
