// Schema + migrations for both engines.
//
// The board/list/card tables keep the shape they've always had, so an existing
// desktop database upgrades in place rather than being rebuilt. What's new:
//
//   users / sessions / api_tokens / devices
//     Cloud mode is multi-tenant. Desktop mode still creates these tables and
//     seeds exactly one local user, so there is a single code path for
//     ownership rather than a pile of `if (multiUser)` branches. The desktop
//     app never shows a login screen — it auto-signs-in as that local user.
//
//   uid / updated_at / rev on every syncable table
//     Sync can't use the integer primary keys: two devices working offline both
//     hand out id 7, and neither is wrong. Every syncable row therefore carries
//     a UUID that is generated once, on whichever device created the row, and
//     never changes. `rev` is a monotonic counter used as the pull cursor.
//
//   sync_tombstones
//     A deleted row can't announce its own deletion, so deletes are recorded
//     here for peers to replay.
//
// Migrations are additive and idempotent: every call re-checks and adds what's
// missing, which is how an already-installed desktop copy picks up the new
// columns without the user doing anything.

const crypto = require('crypto');

// Tables that participate in sync, in dependency order (parents first) so a
// replay never inserts a child before its parent exists.
const SYNCABLE = [
  'boards',
  'lists',
  'cards',
  'labels',
  'card_labels',
  'checklists',
  'checklist_items',
  'comments',
  'attachments'
];

function ddl(dialect) {
  const pk = dialect === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const int = dialect === 'pg' ? 'BIGINT' : 'INTEGER';
  const now = dialect === 'pg'
    ? "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')"
    : "datetime('now')";

  return `
    CREATE TABLE IF NOT EXISTS users (
      id ${pk},
      uid TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT 'free',
      storage_quota_bytes ${int} NOT NULL DEFAULT 0,
      is_local ${int} NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id ${pk},
      token TEXT NOT NULL UNIQUE,
      user_id ${int} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (${now}),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id ${pk},
      uid TEXT NOT NULL UNIQUE,
      user_id ${int} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Token',
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'sync,mcp',
      created_at TEXT NOT NULL DEFAULT (${now}),
      last_used_at TEXT DEFAULT NULL,
      revoked_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id ${pk},
      uid TEXT NOT NULL UNIQUE,
      user_id ${int} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Device',
      platform TEXT NOT NULL DEFAULT '',
      cursor ${int} NOT NULL DEFAULT 0,
      last_sync_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS boards (
      id ${pk},
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#6366f1',
      emoji TEXT NOT NULL DEFAULT '📋',
      starred ${int} NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS lists (
      id ${pk},
      board_id ${int} NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position ${int} NOT NULL DEFAULT 0,
      archived ${int} NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS cards (
      id ${pk},
      list_id ${int} NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      position ${int} NOT NULL DEFAULT 0,
      due_date TEXT DEFAULT NULL,
      archived ${int} NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS labels (
      id ${pk},
      board_id ${int} NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#22c55e'
    );

    CREATE TABLE IF NOT EXISTS card_labels (
      card_id ${int} NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id ${int} NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS checklists (
      id ${pk},
      card_id ${int} NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Checklist',
      position ${int} NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id ${pk},
      checklist_id ${int} NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done ${int} NOT NULL DEFAULT 0,
      position ${int} NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS comments (
      id ${pk},
      card_id ${int} NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT 'Admin',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id ${pk},
      card_id ${int} NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size ${int} NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS activity (
      id ${pk},
      board_id ${int} NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      card_id ${int} DEFAULT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS sync_tombstones (
      id ${pk},
      tbl TEXT NOT NULL,
      uid TEXT NOT NULL,
      owner_id ${int} NOT NULL DEFAULT 0,
      rev ${int} NOT NULL DEFAULT 0,
      deleted_at TEXT NOT NULL DEFAULT (${now})
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      k TEXT PRIMARY KEY,
      v ${int} NOT NULL DEFAULT 0
    );

    -- Public read-only board links. Cloud-side only: they never sync.
    CREATE TABLE IF NOT EXISTS share_links (
      id ${pk},
      uid TEXT NOT NULL UNIQUE,
      board_id ${int} NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (${now}),
      revoked_at TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id);
    CREATE INDEX IF NOT EXISTS idx_cards_list ON cards(list_id);
    CREATE INDEX IF NOT EXISTS idx_labels_board ON labels(board_id);
    CREATE INDEX IF NOT EXISTS idx_checklists_card ON checklists(card_id);
    CREATE INDEX IF NOT EXISTS idx_items_checklist ON checklist_items(checklist_id);
    CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id);
    CREATE INDEX IF NOT EXISTS idx_activity_board ON activity(board_id);
    CREATE INDEX IF NOT EXISTS idx_activity_card ON activity(card_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_tombstones_owner_rev ON sync_tombstones(owner_id, rev);
  `;
}

// ---- additive column migrations -------------------------------------------
// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so anything added
// after a release ships lands here instead.

async function columnExists(store, table, column) {
  if (store.dialect === 'pg') {
    const row = await store.one(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_name = ? AND column_name = ?`,
      [table, column]
    );
    return !!row;
  }
  const cols = await store.all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function addColumn(store, table, column, decl) {
  if (await columnExists(store, table, column)) return false;
  await store.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

// Ownership is denormalised onto every syncable row. Scoping still *derives*
// through the board (the board is the only place it can change hands), but
// carrying owner_id on each row makes two hot paths trivially correct:
// sync pull ("my rows with rev > N") needs no join chain, and a delete
// trigger can record the owner in its tombstone even though the parent rows
// are already gone by the time the cascade reaches it.
async function backfillOwners(store) {
  await store.run(`UPDATE lists SET owner_id = COALESCE(
    (SELECT b.owner_id FROM boards b WHERE b.id = lists.board_id), 0) WHERE owner_id = 0`);
  await store.run(`UPDATE labels SET owner_id = COALESCE(
    (SELECT b.owner_id FROM boards b WHERE b.id = labels.board_id), 0) WHERE owner_id = 0`);
  await store.run(`UPDATE cards SET owner_id = COALESCE(
    (SELECT b.owner_id FROM lists l JOIN boards b ON b.id = l.board_id
     WHERE l.id = cards.list_id), 0) WHERE owner_id = 0`);
  for (const table of ['checklists', 'comments', 'attachments']) {
    await store.run(`UPDATE ${table} SET owner_id = COALESCE(
      (SELECT b.owner_id FROM cards c JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
       WHERE c.id = ${table}.card_id), 0) WHERE owner_id = 0`);
  }
  await store.run(`UPDATE checklist_items SET owner_id = COALESCE(
    (SELECT b.owner_id FROM checklists cl JOIN cards c ON c.id = cl.card_id
     JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
     WHERE cl.id = checklist_items.checklist_id), 0) WHERE owner_id = 0`);
  await store.run(`UPDATE card_labels SET owner_id = COALESCE(
    (SELECT b.owner_id FROM cards c JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
     WHERE c.id = card_labels.card_id), 0) WHERE owner_id = 0`);
}

// ---- tombstone triggers ----------------------------------------------------
// A deleted row can't announce its own deletion, and a board delete cascades
// through every child table — so deletes are recorded by AFTER DELETE
// triggers, and no SELECT anywhere needs a deleted_at filter.
//
// The handoff's SQLite gotcha: cascades only fire triggers with
// recursive_triggers ON (set in sqlite.js). The documented re-fire hazard
// came from the idea of rev-stamping AFTER INSERT/UPDATE triggers — we stamp
// rev in app code instead, so the only triggers are these delete ones, which
// insert into a table that has no triggers of its own. The chain terminates
// by construction; no WHEN guard is needed.
async function createTombstoneTriggers(store) {
  if (store.dialect === 'pg') {
    await store.exec(`
      CREATE OR REPLACE FUNCTION boardly_tombstone() RETURNS trigger AS $body$
      BEGIN
        UPDATE sync_state SET v = v + 1 WHERE k = 'rev';
        INSERT INTO sync_tombstones (tbl, uid, owner_id, rev, deleted_at)
        VALUES (TG_TABLE_NAME, OLD.uid, OLD.owner_id,
                (SELECT v FROM sync_state WHERE k = 'rev'), {{now}});
        RETURN OLD;
      END;
      $body$ LANGUAGE plpgsql
    `);
    for (const table of SYNCABLE) {
      await store.exec(`DROP TRIGGER IF EXISTS boardly_tomb_${table} ON ${table}`);
      await store.exec(
        `CREATE TRIGGER boardly_tomb_${table} AFTER DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION boardly_tombstone()`
      );
    }
    return;
  }
  for (const table of SYNCABLE) {
    await store.exec(`
      CREATE TRIGGER IF NOT EXISTS boardly_tomb_${table} AFTER DELETE ON ${table}
      BEGIN
        UPDATE sync_state SET v = v + 1 WHERE k = 'rev';
        INSERT INTO sync_tombstones (tbl, uid, owner_id, rev, deleted_at)
        VALUES ('${table}', OLD.uid, OLD.owner_id,
                (SELECT v FROM sync_state WHERE k = 'rev'), {{now}});
      END
    `);
  }
}

async function migrate(store) {
  await store.exec(ddl(store.dialect));

  const int = store.dialect === 'pg' ? 'BIGINT' : 'INTEGER';

  // Pre-dating the cloud work.
  await addColumn(store, 'boards', 'description', "TEXT NOT NULL DEFAULT ''");

  // Ownership. Desktop rows all belong to the single local user; the backfill
  // below assigns them once, on first upgrade.
  await addColumn(store, 'boards', 'owner_id', `${int} NOT NULL DEFAULT 0`);

  // Hosted attachment blobs. Default ON while registration is free — when
  // billing lands this becomes the paid storage add-on switch.
  await addColumn(store, 'users', 'storage_enabled', `${int} NOT NULL DEFAULT 1`);

  // Sync bookkeeping on every syncable table.
  for (const table of SYNCABLE) {
    await addColumn(store, table, 'uid', 'TEXT');
    await addColumn(store, table, 'updated_at', "TEXT NOT NULL DEFAULT ''");
    await addColumn(store, table, 'rev', `${int} NOT NULL DEFAULT 0`);
    await addColumn(store, table, 'owner_id', `${int} NOT NULL DEFAULT 0`);
  }

  // A unique index rather than a UNIQUE column constraint, because ALTER TABLE
  // ADD COLUMN can't add one in SQLite.
  for (const table of SYNCABLE) {
    await store.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uid ON ${table}(uid)`);
    await store.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_rev ON ${table}(rev)`);
  }

  await store.run('INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO NOTHING', ['rev', 0]);

  // Backfill uids for rows that predate the column.
  for (const table of SYNCABLE) {
    const missing = await store.all(
      table === 'card_labels'
        ? 'SELECT card_id, label_id FROM card_labels WHERE uid IS NULL'
        : `SELECT id FROM ${table} WHERE uid IS NULL`
    );
    for (const row of missing) {
      const uid = crypto.randomUUID();
      if (table === 'card_labels') {
        await store.run('UPDATE card_labels SET uid = ? WHERE card_id = ? AND label_id = ?',
          [uid, row.card_id, row.label_id]);
      } else {
        await store.run(`UPDATE ${table} SET uid = ? WHERE id = ?`, [uid, row.id]);
      }
    }
  }

  await backfillOwners(store);

  // The LWW clock needs a real value on every row; rows that predate the
  // sync columns inherit their created_at (or the migration time when the
  // table never had one).
  for (const table of SYNCABLE) {
    await store.run(
      table === 'labels' || table === 'card_labels' || table === 'checklists' || table === 'checklist_items'
        ? `UPDATE ${table} SET updated_at = {{now}} WHERE updated_at = ''`
        : `UPDATE ${table} SET updated_at = created_at WHERE updated_at = ''`
    );
  }

  await createTombstoneTriggers(store);

  return store;
}

// Desktop mode owns its data outright: one implicit user, no password, no
// login screen. Cloud mode never calls this.
async function ensureLocalUser(store) {
  const existing = await store.one('SELECT * FROM users WHERE is_local = 1 ORDER BY id LIMIT 1');
  if (existing) return existing;
  const row = await store.one(
    `INSERT INTO users (uid, email, password_hash, name, plan, is_local)
     VALUES (?, ?, '', ?, 'local', 1) RETURNING *`,
    [crypto.randomUUID(), 'local@boardly.app', 'You']
  );
  // Adopt any boards created before accounts existed, then re-run the owner
  // backfill so child rows pick up the adoption too (migrate() ran before the
  // local user existed).
  await store.run('UPDATE boards SET owner_id = ? WHERE owner_id = 0', [row.id]);
  await backfillOwners(store);
  return row;
}

module.exports = { migrate, ensureLocalUser, backfillOwners, SYNCABLE };
