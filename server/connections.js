const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createConnections(root) {
  fs.mkdirSync(root, { recursive: true });
  const db = new Database(path.join(root, 'connections.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    last_used_at INTEGER, revoked_at INTEGER, initialized INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS cloud_workspaces (owner_id TEXT PRIMARY KEY)');
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  return {
    rememberWorkspace(ownerId){db.prepare('INSERT OR IGNORE INTO cloud_workspaces VALUES (?)').run(ownerId);},
    workspaceOwners(){return db.prepare('SELECT owner_id FROM cloud_workspaces').all().map(r=>r.owner_id);},
    issue(userId, name, scope) {
      const id = crypto.randomUUID(), token = 'bdly_' + crypto.randomBytes(32).toString('base64url');
      const now = Date.now(), expires = now + 90 * 86400000;
      db.prepare('INSERT INTO connections (id,user_id,name,scope,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, userId, name, scope, hash(token), now, expires);
      return { id, token, name, scope, created_at: now, expires_at: expires };
    },
    authenticate(token) {
      const row = db.prepare('SELECT * FROM connections WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hash(token), Date.now());
      if (row) db.prepare('UPDATE connections SET last_used_at=? WHERE id=?').run(Date.now(), row.id);
      return row;
    },
    list(userId) { return db.prepare('SELECT id,name,scope,created_at,expires_at,last_used_at,revoked_at FROM connections WHERE user_id=? ORDER BY created_at DESC').all(userId); },
    revoke(userId, id) { return db.prepare('UPDATE connections SET revoked_at=? WHERE user_id=? AND id=?').run(Date.now(), userId, id).changes; },
    initialize(id) { db.prepare('UPDATE connections SET initialized=1 WHERE id=?').run(id); },
    close() { db.close(); },
  };
}
module.exports = { createConnections };
