// Sync-server database: accounts, bearer tokens (sha256-hashed), Whop
// entitlements, per-account entity store with server-assigned sequence, and
// attachment metadata. Attachment bytes live as files under
// DATA_DIR/blobs/<account_id>/<uuid> — only metadata goes in SQLite.
// The server never interprets entity payloads; they are opaque JSON.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'blobs'), { recursive: true });
  const db = new Database(path.join(dataDir, 'sync.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      whop_user_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    -- status: active | grace | suspended. Written by the Whop webhook /
    -- daily revalidation job (Phase 4); dev bootstrap can seed it for tests.
    CREATE TABLE IF NOT EXISTS entitlements (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'active',
      grace_ends_at INTEGER,
      renews_at INTEGER,
      checked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS account_seq (
      account_id INTEGER PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS entities (
      account_id INTEGER NOT NULL,
      table_name TEXT NOT NULL,
      uuid TEXT NOT NULL,
      payload TEXT,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL,
      PRIMARY KEY (account_id, table_name, uuid)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_seq ON entities(account_id, seq);
    CREATE TABLE IF NOT EXISTS attachments (
      account_id INTEGER NOT NULL,
      uuid TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, uuid)
    );
    -- Token emails that could not be delivered (no buyer email in the
    -- webhook payload, mail not configured, SMTP send error). Rows here
    -- are the replay list for ops.
    CREATE TABLE IF NOT EXISTS mail_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      email TEXT,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function blobPath(dataDir, accountId, uuid) {
  return path.join(dataDir, 'blobs', String(accountId), uuid);
}

module.exports = { openDb, blobPath };
