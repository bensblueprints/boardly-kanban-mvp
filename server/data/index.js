// Store factory. Picks the engine from configuration and runs migrations.
//
// The rule is simple: a DATABASE_URL means cloud mode (Postgres, multi-tenant,
// registration open); its absence means desktop mode (SQLite in the user's own
// data directory, one local account, no login screen). Nothing else in the
// codebase needs to branch on which mode it's in — it asks the store.

const path = require('path');
const { createSqliteStore } = require('./sqlite.js');
const { createPgStore } = require('./pg.js');
const { migrate, ensureLocalUser } = require('./schema.js');

async function openStore(opts = {}) {
  // Explicit null means "SQLite even if the environment says Postgres" —
  // the sync test runs a desktop client next to a cloud server in one
  // process, with DATABASE_URL set for the cloud side only.
  const url = opts.databaseUrl === undefined
    ? (process.env.DATABASE_URL || null)
    : opts.databaseUrl;

  let store;
  if (url) {
    store = createPgStore({
      url,
      ssl: opts.ssl ?? process.env.DATABASE_SSL === '1',
      poolSize: Number(opts.poolSize || process.env.DATABASE_POOL || 10)
    });
    store.mode = 'cloud';
  } else {
    const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    store = createSqliteStore({ dataDir });
    store.mode = 'desktop';
    store.dataDir = dataDir;
  }

  // Test hook: force cloud semantics (multi-user, no implicit local account)
  // on the SQLite store, since the account logic is engine-independent.
  if (opts.mode) store.mode = opts.mode;

  await migrate(store);
  if (store.mode === 'desktop') {
    store.localUser = await ensureLocalUser(store);
  }
  return store;
}

module.exports = { openStore };
