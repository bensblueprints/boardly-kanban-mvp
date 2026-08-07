// Store-layer checks: dialect translation, migrations, transactions.
//
// The translation assertions are pure and cover the Postgres dialect without
// needing a Postgres server — they're the only guard against dialect bugs until
// the app runs against a real one. The live checks exercise SQLite.
//
// Run against real Postgres with:  DATABASE_URL=postgres://... node test/store.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');

const { openStore } = require('../server/data/index.js');
const { migrate } = require('../server/data/schema.js');
const { prepare } = require('../server/data/sql.js');

let pass = 0;
const ok = (name) => { console.log('  ✓', name); pass++; };

(async () => {
  // ---- translation (no database needed) ----
  assert.strictEqual(
    prepare('SELECT * FROM t WHERE a = ? AND b = ?', 'pg'),
    'SELECT * FROM t WHERE a = $1 AND b = $2'
  );
  ok('pg: ? becomes $n');

  assert.strictEqual(
    prepare("SELECT '?' AS lit, x FROM t WHERE y = ?", 'pg'),
    "SELECT '?' AS lit, x FROM t WHERE y = $1"
  );
  ok('pg: ? inside a string literal is left alone');

  assert.strictEqual(
    prepare("SELECT 'it''s ?' AS lit WHERE y = ?", 'pg'),
    "SELECT 'it''s ?' AS lit WHERE y = $1"
  );
  ok('pg: escaped quotes do not break literal scanning');

  assert.strictEqual(
    prepare('SELECT 1 -- trailing ?\nWHERE y = ?', 'pg'),
    'SELECT 1 -- trailing ?\nWHERE y = $1'
  );
  ok('pg: ? inside a comment is left alone');

  assert.strictEqual(prepare('SELECT * FROM t WHERE a = ?', 'sqlite'), 'SELECT * FROM t WHERE a = ?');
  ok('sqlite: placeholders pass through');

  assert.match(prepare('SELECT {{now}}', 'sqlite'), /datetime\('now'\)/);
  assert.match(prepare('SELECT {{now}}', 'pg'), /to_char\(now\(\)/);
  ok('{{now}} expands per dialect');

  // SQLite LIKE is case-insensitive, Postgres LIKE is not — without ILIKE the
  // cloud would search differently from the desktop.
  assert.match(prepare('WHERE t {{ilike}} ?', 'pg'), /ILIKE \$1/);
  assert.match(prepare('WHERE t {{ilike}} ?', 'sqlite'), /LIKE \?/);
  ok('{{ilike}} keeps search case-insensitive on both engines');

  assert.match(prepare('WHERE d <= {{now+7d}}', 'pg'), /interval '7 days'/);
  assert.match(prepare('WHERE d >= {{now-1d}}', 'sqlite'), /'-1 day'/);
  ok('{{now±Nd}} expands per dialect');

  assert.match(prepare('INSERT OR IGNORE INTO t (a) VALUES (?)', 'pg'), /ON CONFLICT DO NOTHING/);
  ok('INSERT OR IGNORE rewrites for pg');

  assert.match(
    prepare('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING id', 'pg'),
    /ON CONFLICT DO NOTHING RETURNING id/
  );
  ok('conflict clause lands before RETURNING');

  // ---- live store ----
  const usingPg = !!process.env.DATABASE_URL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-store-'));
  const store = await openStore(usingPg ? {} : { dataDir: dir });

  if (usingPg) {
    assert.strictEqual(store.dialect, 'pg');
    assert.strictEqual(store.mode, 'cloud');
    ok('DATABASE_URL selects cloud mode on Postgres');
  } else {
    assert.strictEqual(store.dialect, 'sqlite');
    assert.strictEqual(store.mode, 'desktop');
    ok('no DATABASE_URL selects desktop mode on SQLite');

    assert.ok(store.localUser && store.localUser.id, 'local user seeded');
    assert.strictEqual(Number(store.localUser.is_local), 1);
    ok('desktop seeds exactly one implicit local user');

    const again = await openStore({ dataDir: dir });
    assert.strictEqual(again.localUser.id, store.localUser.id);
    ok('migrations are idempotent and do not duplicate the local user');
    await again.close();
  }

  const ownerId = store.localUser ? store.localUser.id : 1;

  const board = await store.one(
    'INSERT INTO boards (uid, name, owner_id, updated_at) VALUES (?, ?, ?, {{now}}) RETURNING *',
    [crypto.randomUUID(), 'Test board', ownerId]
  );
  assert.ok(board.id, 'RETURNING gives the row back');
  assert.ok(board.uid, 'uid stored');
  assert.match(board.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  ok('RETURNING + {{now}} produce the expected TEXT timestamp shape');

  // Guards the int8-as-string trap: counts must be numbers, not strings.
  const counted = await store.one('SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?', [ownerId]);
  assert.strictEqual(typeof counted.n, 'number', 'COUNT came back as a number');
  ok('aggregate counts are numbers, not strings');
  assert.strictEqual(typeof board.id, 'number');
  ok('primary keys are numbers, not strings');

  assert.strictEqual((await store.all('SELECT * FROM boards WHERE owner_id = ?', [ownerId])).length, 1);
  ok('all() reads back');

  assert.strictEqual((await store.run('UPDATE boards SET name = ? WHERE id = ?', ['Renamed', board.id])).changes, 1);
  ok('run() reports changes');

  await store.tx(async (t) => {
    await t.run('UPDATE boards SET color = ? WHERE id = ?', ['#ff0000', board.id]);
  });
  assert.strictEqual((await store.one('SELECT color FROM boards WHERE id = ?', [board.id])).color, '#ff0000');
  ok('tx commits');

  await assert.rejects(store.tx(async (t) => {
    await t.run('UPDATE boards SET color = ? WHERE id = ?', ['#00ff00', board.id]);
    throw new Error('boom');
  }), /boom/);
  assert.strictEqual((await store.one('SELECT color FROM boards WHERE id = ?', [board.id])).color, '#ff0000');
  ok('tx rolls back on throw');

  await store.tx(async (t) => {
    await t.run('UPDATE boards SET emoji = ? WHERE id = ?', ['✅', board.id]);
  });
  ok('the tx queue keeps working after a failure');

  // Without the mutex in the SQLite driver these collide on BEGIN.
  await Promise.all([1, 2, 3, 4, 5].map((n) =>
    store.tx(async (t) => {
      await t.run(
        'INSERT INTO lists (uid, board_id, name, position, updated_at) VALUES (?, ?, ?, ?, {{now}})',
        [crypto.randomUUID(), board.id, `L${n}`, n]
      );
    })
  ));
  assert.strictEqual((await store.all('SELECT * FROM lists WHERE board_id = ?', [board.id])).length, 5);
  ok('five concurrent transactions serialise cleanly');

  await store.run('UPDATE lists SET uid = NULL WHERE board_id = ? AND name = ?', [board.id, 'L1']);
  await migrate(store);
  assert.ok((await store.one('SELECT uid FROM lists WHERE board_id = ? AND name = ?', [board.id, 'L1'])).uid);
  ok('migrate() backfills uids onto rows that predate the column');

  // Clean up so a Postgres run is repeatable.
  await store.run('DELETE FROM boards WHERE id = ?', [board.id]);
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nAll ${pass} store checks passed${usingPg ? ' (Postgres)' : ' (SQLite)'}.`);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
