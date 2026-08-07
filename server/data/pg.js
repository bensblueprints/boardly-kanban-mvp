// Postgres driver — the cloud path.
//
// Mirrors the SQLite driver's interface exactly, so application code never
// learns which engine it's talking to. Two details are worth knowing:
//
//   int8 parsing. node-postgres returns bigint columns as *strings* to avoid
//   silent precision loss past 2^53. That would change the API's JSON shape
//   (`"card_count": "3"` instead of `3`) and break arithmetic that works fine
//   on the desktop, so int8 is parsed back to Number here. Boardly's ids and
//   counts are nowhere near the safe-integer ceiling.
//
//   Transactions take a dedicated client out of the pool. The scoped store
//   handed to the callback routes every query through that one client, so a
//   transaction can't leak statements onto other pooled connections.

const { prepare } = require('./sql.js');

function createPgStore({ url, ssl, poolSize }) {
  const pg = require('pg');

  // Return bigint/int8 as a JS number so the API's JSON matches desktop mode.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  // numeric — only ever used here for aggregate results.
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

  const pool = new pg.Pool({
    connectionString: url,
    max: poolSize || 10,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000
  });

  pool.on('error', (err) => {
    // A pooled connection dropped while idle (Postgres restart, network blip).
    // The pool replaces it on the next checkout; log rather than crash.
    console.error('[db] idle client error:', err.message);
  });

  function scoped(client) {
    const exec = (sql, params) => client.query(prepare(sql, 'pg'), params);
    return {
      dialect: 'pg',
      async all(sql, params = []) {
        return (await exec(sql, params)).rows;
      },
      async one(sql, params = []) {
        return (await exec(sql, params)).rows[0];
      },
      async run(sql, params = []) {
        const r = await exec(sql, params);
        return { changes: r.rowCount, lastId: r.rows[0]?.id };
      },
      async exec(sql) {
        await client.query(prepare(sql, 'pg'));
      },
      // Already inside a transaction — just run the callback.
      async tx(fn) {
        return fn(this);
      }
    };
  }

  const store = {
    dialect: 'pg',
    raw: pool,

    async all(sql, params = []) {
      return (await pool.query(prepare(sql, 'pg'), params)).rows;
    },

    async one(sql, params = []) {
      return (await pool.query(prepare(sql, 'pg'), params)).rows[0];
    },

    async run(sql, params = []) {
      const r = await pool.query(prepare(sql, 'pg'), params);
      return { changes: r.rowCount, lastId: r.rows[0]?.id };
    },

    async exec(sql) {
      await pool.query(prepare(sql, 'pg'));
    },

    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(scoped(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    }
  };

  return store;
}

module.exports = { createPgStore };
