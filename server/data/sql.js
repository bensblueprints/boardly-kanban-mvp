// SQL portability layer.
//
// Boardly now runs on two databases: better-sqlite3 on the desktop (embedded,
// offline, owned by the user) and Postgres in the cloud (multi-tenant, concurrent).
// Rather than maintain two sets of queries, application code writes one portable
// dialect and this module translates it.
//
// Two things get translated:
//
//   1. Placeholders. App code always writes `?`; Postgres wants `$1, $2, ...`.
//   2. Tokens. A small set of `{{...}}` macros stand in for the handful of
//      constructs that genuinely differ between the two engines. The set is
//      deliberately tiny — if a query needs something outside it, that's a
//      signal the query should be reshaped rather than the macro list grown.
//
// Everything else (JOINs, CTEs, ON CONFLICT, RETURNING, COALESCE, window-free
// aggregates) is spelled the same way by both engines, so it passes through
// untouched.

// ---- token table ----------------------------------------------------------
// `{{now}}`      UTC timestamp, as TEXT in `YYYY-MM-DD HH:MM:SS`.
// `{{today}}`    UTC date, as TEXT in `YYYY-MM-DD`.
// `{{now±Nd}}`   `{{now}}` shifted by N days, same TEXT format.
// `{{ilike}}`    Case-insensitive LIKE. SQLite's LIKE already ignores ASCII
//                case; Postgres's does not, so it needs ILIKE to match the
//                search behaviour desktop users already have.
// `{{date(x)}}`  Truncate a stored timestamp TEXT to its date part.
//
// Timestamps are stored as TEXT in both engines on purpose. It keeps the JSON
// the API emits byte-identical across modes (a `timestamptz` column would come
// back as a Date and serialise as ISO-8601 with a `T` and a `Z`), which matters
// because export/import round-trips and the sync protocol compare these values.
// UTC TEXT in this format also sorts lexicographically, which is what the sync
// cursor relies on.

const TOKENS = {
  sqlite: {
    now: () => "datetime('now')",
    today: () => "date('now')",
    nowShift: (days) => `datetime('now', '${days >= 0 ? '+' : ''}${days} day')`,
    ilike: () => 'LIKE',
    date: (expr) => `date(${expr})`
  },
  pg: {
    // to_char keeps the TEXT shape identical to SQLite's datetime().
    now: () => "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')",
    today: () => "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD')",
    nowShift: (days) =>
      `to_char((now() AT TIME ZONE 'utc') + interval '${days} days', 'YYYY-MM-DD HH24:MI:SS')`,
    ilike: () => 'ILIKE',
    date: (expr) => `substr(${expr}, 1, 10)`
  }
};

const TOKEN_RE = /\{\{\s*(now|today|ilike|now([+-]\d+)d|date\(([^)]*)\))\s*\}\}/g;

function expandTokens(sql, dialect) {
  const t = TOKENS[dialect];
  if (!t) throw new Error(`Unknown SQL dialect: ${dialect}`);
  return sql.replace(TOKEN_RE, (match, body, shift, dateExpr) => {
    if (body === 'now') return t.now();
    if (body === 'today') return t.today();
    if (body === 'ilike') return t.ilike();
    if (shift) return t.nowShift(Number(shift));
    if (dateExpr !== undefined) return t.date(dateExpr.trim());
    return match;
  });
}

// ---- placeholders ---------------------------------------------------------
// Walks the statement so that a `?` inside a string literal, a quoted
// identifier, or a comment is left alone. Only bare `?` become $n.
function toPositional(sql) {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    // single-quoted literal — '' is an escaped quote, not a terminator
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    // double-quoted identifier
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== '"') i += 1;
      i += 1;
      out += sql.slice(start, i);
      continue;
    }

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += sql.slice(start, i);
      continue;
    }

    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += sql.slice(start, Math.min(i, sql.length));
      continue;
    }

    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

// `INSERT OR IGNORE` is SQLite-only; Postgres spells it as a conflict clause.
// DO NOTHING without a conflict target covers every unique constraint on the
// table, which is the same semantics SQLite gives here.
function rewriteInsertOrIgnore(sql) {
  if (!/INSERT\s+OR\s+IGNORE/i.test(sql)) return sql;
  const rewritten = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  // Append the conflict clause before RETURNING, if there is one.
  const returning = rewritten.match(/\s+RETURNING\s+/i);
  if (returning) {
    const at = returning.index;
    return `${rewritten.slice(0, at)} ON CONFLICT DO NOTHING${rewritten.slice(at)}`;
  }
  return `${rewritten} ON CONFLICT DO NOTHING`;
}

// `INSERT OR REPLACE` — used by the sync engine's upserts.
function rewriteInsertOrReplace(sql, dialect) {
  if (dialect !== 'pg') return sql;
  return sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO');
}

function prepare(sql, dialect) {
  let out = expandTokens(sql, dialect);
  if (dialect === 'pg') {
    out = rewriteInsertOrIgnore(out);
    out = rewriteInsertOrReplace(out, dialect);
    out = toPositional(out);
  }
  return out;
}

module.exports = { prepare, expandTokens, toPositional };
