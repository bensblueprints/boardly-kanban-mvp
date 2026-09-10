// Change-tracking infrastructure for cloud sync.
// Installs uuid/updated_at columns, stamping triggers, and tombstone capture
// on every syncable table. All tracking is trigger-based so every write path
// (HTTP routes in app.js, MCP tools, coach) is covered uniformly.
//
// The sync engine sets sync_meta.suppress_tracking='1' while applying remote
// changes so pulled rows don't re-enter the local change queue.

const TRACKED_TABLES = [
  'boards',
  'lists',
  'cards',
  'labels',
  'card_labels',
  'checklists',
  'checklist_items',
  'comments',
  'attachments',
];

// Epoch milliseconds, evaluated per-row. (julianday()-based expressions lose
// several ms to float rounding; unixepoch('now','subsec') is exact.)
const MS_NOW = `CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)`;

// RFC 4122 v4 UUID, evaluated per-row.
const UUID_EXPR = `lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))
)`;

// Trigger guard: skip tracking while the sync engine applies remote changes.
const NOT_SUPPRESSED = `(SELECT COALESCE((SELECT value FROM sync_meta WHERE key = 'suppress_tracking'), '0')) = '0'`;

function installSyncTracking(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      uuid TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tombstones_deleted ON tombstones(deleted_at);
  `);

  const addColumn = (table, column, decl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  };

  for (const table of TRACKED_TABLES) {
    addColumn(table, 'uuid', 'TEXT');
    addColumn(table, 'updated_at', 'INTEGER');

    // Backfill rows created before sync tracking existed.
    db.prepare(`UPDATE ${table} SET uuid = ${UUID_EXPR} WHERE uuid IS NULL`).run();
    db.prepare(
      `UPDATE ${table} SET updated_at = ${MS_NOW} WHERE updated_at IS NULL`
    ).run();

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uuid ON ${table}(uuid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_updated ON ${table}(updated_at)`);

    // card_labels has no rowid-independent PK but always has rowid (no WITHOUT ROWID).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_insert AFTER INSERT ON ${table}
      WHEN ${NOT_SUPPRESSED}
      BEGIN
        UPDATE ${table}
           SET uuid = COALESCE(NEW.uuid, ${UUID_EXPR}),
               updated_at = COALESCE(NEW.updated_at, ${MS_NOW})
         WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_update AFTER UPDATE ON ${table}
      WHEN ${NOT_SUPPRESSED} AND NEW.updated_at IS OLD.updated_at
      BEGIN
        UPDATE ${table} SET updated_at = ${MS_NOW} WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_delete AFTER DELETE ON ${table}
      WHEN ${NOT_SUPPRESSED} AND OLD.uuid IS NOT NULL
      BEGIN
        INSERT OR REPLACE INTO tombstones (uuid, table_name, deleted_at)
        VALUES (OLD.uuid, '${table}', ${MS_NOW});
      END;
    `);
  }

  db.prepare(
    `INSERT OR IGNORE INTO sync_meta (key, value) VALUES
      ('cursor', '0'), ('last_push_at', '0'), ('suppress_tracking', '0')`
  ).run();
}

// Run fn with change tracking suppressed (sync engine applying remote rows).
function withTrackingSuppressed(db, fn) {
  db.prepare(`UPDATE sync_meta SET value = '1' WHERE key = 'suppress_tracking'`).run();
  try {
    return fn();
  } finally {
    db.prepare(`UPDATE sync_meta SET value = '0' WHERE key = 'suppress_tracking'`).run();
  }
}

function getSyncMeta(db, key) {
  const row = db.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSyncMeta(db, key, value) {
  db.prepare(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

// All locally-changed rows (by updated_at) and tombstones (by deleted_at) since `sinceMs`.
function listLocalChanges(db, sinceMs) {
  const changes = [];
  for (const table of TRACKED_TABLES) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE updated_at > ? AND uuid IS NOT NULL`)
      .all(sinceMs);
    for (const row of rows) changes.push({ table, deleted: false, row });
  }
  const tombs = db
    .prepare(`SELECT uuid, table_name, deleted_at FROM tombstones WHERE deleted_at > ?`)
    .all(sinceMs);
  for (const t of tombs) {
    changes.push({
      table: t.table_name,
      deleted: true,
      row: { uuid: t.uuid, updated_at: t.deleted_at },
    });
  }
  return changes;
}

module.exports = {
  TRACKED_TABLES,
  MS_NOW,
  UUID_EXPR,
  installSyncTracking,
  withTrackingSuppressed,
  getSyncMeta,
  setSyncMeta,
  listLocalChanges,
};
