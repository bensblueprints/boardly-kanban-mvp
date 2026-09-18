// Adapter for the released desktop sync protocol. The cloud workspace itself
// is the source of truth; a sequence journal also captures web and MCP edits.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { TABLE_ORDER, rowToPayload } = require('./serialize');
const { FIELDS, PARENTS, attachmentFilename } = require('./engine');
const { withTrackingSuppressed } = require('./track');
const uuid = z.string().uuid();
const numeric = new Set(['position', 'starred', 'archived', 'done', 'size']);
const nullable = new Set(['due_date']);
const shapes = Object.fromEntries(TABLE_ORDER.map(table => [table, z.object({
  ...Object.fromEntries(PARENTS[table].map(([, , key]) => [key, uuid])),
  ...Object.fromEntries(FIELDS[table].map(key => [key, numeric.has(key)
    ? z.number().int().nonnegative().max(1000000000)
    : nullable.has(key) ? z.string().max(100).nullable() : z.string().max(200000)])),
})]));

function createSyncHub({ db, uploadsDir, engine, connections }) {
  const router = express.Router();
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_sync_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, uuid TEXT NOT NULL,
    updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL, payload TEXT,
    UNIQUE(table_name, uuid)
  )`);
  const put = db.prepare('INSERT OR REPLACE INTO cloud_sync_changes (table_name,uuid,updated_at,deleted,payload) VALUES (?,?,?,?,?)');
  const get = db.prepare('SELECT * FROM cloud_sync_changes WHERE table_name=? AND uuid=?');
  const staged = id => path.join(uploadsDir, `sync-${id}.bin`);

  function refresh() {
    db.transaction(() => {
      for (const table of TABLE_ORDER) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        const present = new Set(rows.map(r => r.uuid));
        for (const row of rows) {
          const payload = JSON.stringify(rowToPayload(db, table, row));
          const prior = get.get(table, row.uuid);
          if (prior && !prior.deleted && prior.payload === payload && prior.updated_at === row.updated_at) continue;
          let stamp = row.updated_at;
          if (prior && stamp <= prior.updated_at) {
            stamp = prior.updated_at + 1;
            withTrackingSuppressed(db, () => db.prepare(`UPDATE ${table} SET updated_at=? WHERE uuid=?`).run(stamp, row.uuid));
          }
          put.run(table, row.uuid, stamp, 0, payload);
        }
        for (const old of db.prepare('SELECT * FROM cloud_sync_changes WHERE table_name=? AND deleted=0').all(table)) {
          if (!present.has(old.uuid)) put.run(table, old.uuid, Math.max(Date.now(), old.updated_at + 1), 1, null);
        }
      }
    })();
  }

  router.post('/api/sync/push', express.json({ limit: '16mb' }), (req, res) => {
    const batch = req.body?.changes;
    if (!Array.isArray(batch) || batch.length > 10000) return res.status(400).json({ error: 'Send at most 10000 changes' });
    const changes = [];
    for (const c of batch) {
      if (!c || !TABLE_ORDER.includes(c.table) || !uuid.safeParse(c.uuid).success ||
          !Number.isSafeInteger(c.updated_at) || c.updated_at < 0 || c.updated_at > Date.now() + 300000 ||
          typeof c.deleted !== 'boolean') return res.status(400).json({ error: 'Invalid sync change' });
      const payload = c.deleted ? null : shapes[c.table].safeParse(c.payload);
      if (payload && !payload.success) return res.status(400).json({ error: `Invalid ${c.table} payload` });
      if (c.table === 'attachments' && !c.deleted && !findFile(c.uuid)) return res.status(409).json({ error: 'Upload attachment bytes before its metadata' });
      changes.push({ ...c, payload: payload ? payload.data : null });
    }
    let accepted = 0, rejected = 0;
    db.transaction(() => {
      refresh();
      const apply = [];
      for (const c of changes) {
        const old = get.get(c.table, c.uuid);
        if (old && c.updated_at < old.updated_at) { rejected++; continue; }
        if (old && c.updated_at === old.updated_at && !!old.deleted === c.deleted && old.payload === (c.deleted ? null : JSON.stringify(c.payload))) { accepted++; continue; }
        if (old && c.updated_at <= old.updated_at) c.updated_at = old.updated_at + 1;
        apply.push(c); accepted++;
      }
      engine.applyIncoming(apply);
      for (const c of apply) {
        if (c.deleted) {
          put.run(c.table, c.uuid, c.updated_at, 1, null);
          if (c.table === 'attachments') fs.rmSync(staged(c.uuid), { force: true });
        } else if (c.table === 'attachments') {
          const row = db.prepare('SELECT * FROM attachments WHERE uuid=?').get(c.uuid);
          if (row && fs.existsSync(staged(c.uuid))) {
            fs.copyFileSync(staged(c.uuid), path.join(uploadsDir, row.filename));
            fs.rmSync(staged(c.uuid), { force: true });
          }
        }
      }
      refresh();
    })();
    res.json({ accepted, rejected });
  });
  router.get('/api/sync/pull', (req, res) => {
    refresh();
    let cursor = Math.max(0, Number(req.query.cursor) || 0);
    const max = db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM cloud_sync_changes').get().n;
    if (cursor > max || (req.boardlyConnection && !req.boardlyConnection.initialized)) cursor = 0;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(req.query.limit) || 500)));
    const rows = db.prepare('SELECT * FROM cloud_sync_changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor, limit + 1);
    const page = rows.slice(0, limit);
    if (req.boardlyConnection) connections.initialize(req.boardlyConnection.id);
    res.json({ changes: page.map(r => ({ table: r.table_name, uuid: r.uuid, updated_at: r.updated_at,
      deleted: !!r.deleted, payload: r.payload ? JSON.parse(r.payload) : null, seq: r.seq })),
      cursor: page.length ? page.at(-1).seq : cursor, hasMore: rows.length > limit });
  });
  function findFile(id) {
    if (!uuid.safeParse(id).success) return null;
    const row = db.prepare('SELECT * FROM attachments WHERE uuid=?').get(id);
    const file = row ? path.join(uploadsDir, row.filename) : staged(id);
    return fs.existsSync(file) ? file : null;
  }
  router.put('/api/sync/attachments/:uuid', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
    if (!uuid.safeParse(req.params.uuid).success || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Invalid attachment' });
    if (!findFile(req.params.uuid)) fs.writeFileSync(staged(req.params.uuid), req.body, { mode: 0o600 });
    res.json({ ok: true, size: req.body.length });
  });
  router.route('/api/sync/attachments/:uuid').head((req, res) => {
    const file = findFile(req.params.uuid);
    if (!file) return res.status(404).end();
    res.setHeader('Content-Length', fs.statSync(file).size); res.status(200).end();
  }).get((req, res) => {
    const file = findFile(req.params.uuid);
    if (!file) return res.status(404).json({ error: 'Attachment not found' });
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.download(file, path.basename(file));
  });
  router.get('/api/account/status', (req, res) => res.json({ active: true, status: 'active', renews_at: null }));
  return router;
}
module.exports = { createSyncHub };
