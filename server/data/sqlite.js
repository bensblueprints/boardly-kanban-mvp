// SQLite driver — the desktop path.
//
// better-sqlite3 is synchronous, but the store interface is async so that one
// set of application code can also run on Postgres. The wrappers below are
// therefore async in signature and immediate in practice: no query here ever
// actually yields, which keeps desktop behaviour exactly as it was.
//
// Transactions need care. better-sqlite3's own `db.transaction()` helper only
// accepts a synchronous function, so it can't wrap an `async` callback. We
// issue BEGIN/COMMIT/ROLLBACK directly instead — and because an `await` inside
// a transaction callback would otherwise let a second request interleave its
// own BEGIN ("cannot start a transaction within a transaction"), transactions
// are serialised through a promise-chain mutex.

const path = require('path');
const fs = require('fs');
const { prepare } = require('./sql.js');

function nativeBindingPath() {
  // Under Electron the Node-ABI binding won't load; use the vendored Electron prebuild.
  if (!process.versions.electron) return null;
  const p = path.join(__dirname, '..', '..', 'vendor', 'better_sqlite3-electron.node');
  return fs.existsSync(p) ? p : null;
}

function createSqliteStore({ dataDir }) {
  // Required lazily so the cloud image never has to build the native module.
  const Database = require('better-sqlite3');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

  const nativeBinding = nativeBindingPath();
  const db = new Database(path.join(dataDir, 'app.db'), nativeBinding ? { nativeBinding } : {});
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Cascade deletes must fire the tombstone triggers (see schema.js). Safe
  // here because no trigger updates its own table — the only triggers are
  // AFTER DELETE inserts into sync_tombstones, which has no triggers.
  db.pragma('recursive_triggers = ON');

  const cache = new Map();
  function stmt(sql) {
    const text = prepare(sql, 'sqlite');
    let s = cache.get(text);
    if (!s) {
      s = db.prepare(text);
      cache.set(text, s);
    }
    return s;
  }

  // Serialises transactions against each other (see note above).
  let queue = Promise.resolve();

  const store = {
    dialect: 'sqlite',
    raw: db,

    async all(sql, params = []) {
      return stmt(sql).all(...params);
    },

    async one(sql, params = []) {
      return stmt(sql).get(...params);
    },

    async run(sql, params = []) {
      const info = stmt(sql).run(...params);
      return { changes: info.changes, lastId: info.lastInsertRowid };
    },

    async exec(sql) {
      db.exec(prepare(sql, 'sqlite'));
    },

    async tx(fn) {
      const run = async () => {
        db.exec('BEGIN');
        try {
          const result = await fn(store);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      };
      // Chain onto the queue, and keep the queue alive on failure.
      const next = queue.then(run, run);
      queue = next.then(() => {}, () => {});
      return next;
    },

    async close() {
      db.close();
    }
  };

  return store;
}

module.exports = { createSqliteStore };
