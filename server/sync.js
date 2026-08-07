// Sync engine — the wire format and the desktop client.
//
// Wire format. Rows travel as plain objects keyed by uid; integer primary
// keys never cross the wire (two devices both hand out id 7 offline, and
// neither is wrong). References travel as `<ref>_uid` and are resolved to
// local integer ids on arrival. `updated_at` (UTC TEXT) is the LWW clock and
// `rev` is the pulling side's cursor: the cloud assigns revs from its
// store-wide counter on every write it accepts; the desktop assigns its own
// local revs to locally-written rows and sets rev = -1 on rows it applies
// from the cloud, so "rev > push cursor" (cursor starts at -1) means exactly
// "written here" — legacy pre-sync rows sit at rev 0 and are picked up by the
// first push, while cloud-applied rows are never pushed back.
//
// Last-write-wins, per record: the row with the strictly greater updated_at
// wins. On an exact tie the CLOUD's row wins — the cloud is the hub every
// device converges on, so one side has to be the tie-breaker and it is the
// side every other device can see.
//
// Deletes travel as tombstones (uid only) written by AFTER DELETE triggers;
// applying a delete for a row that isn't there is a no-op, so tombstone
// echoes between peers terminate instead of looping.
//
// Attachments sync as metadata only — blobs stay on the device that has them
// (hosted blob storage is the future paid add-on).

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { SYNCABLE } = require('./data/schema.js');

// Reference columns, in wire terms. `as` is the wire key, `table`/`column`
// the local parent lookup.
const REFS = {
  boards: [],
  lists: [{ as: 'board_uid', table: 'boards', column: 'board_id' }],
  cards: [{ as: 'list_uid', table: 'lists', column: 'list_id' }],
  labels: [{ as: 'board_uid', table: 'boards', column: 'board_id' }],
  card_labels: [
    { as: 'card_uid', table: 'cards', column: 'card_id' },
    { as: 'label_uid', table: 'labels', column: 'label_id' }
  ],
  checklists: [{ as: 'card_uid', table: 'cards', column: 'card_id' }],
  checklist_items: [{ as: 'checklist_uid', table: 'checklists', column: 'checklist_id' }],
  comments: [{ as: 'card_uid', table: 'cards', column: 'card_id' }],
  attachments: [{ as: 'card_uid', table: 'cards', column: 'card_id' }]
};

// Content columns (everything except the key, refs, owner and sync
// bookkeeping). created_at is insert-only — never overwritten on update.
const COLS = {
  boards: ['name', 'description', 'color', 'emoji', 'starred', 'created_at'],
  lists: ['name', 'position', 'archived', 'created_at'],
  cards: ['title', 'description', 'position', 'due_date', 'archived', 'created_at'],
  labels: ['name', 'color'],
  card_labels: [],
  checklists: ['title', 'position'],
  checklist_items: ['text', 'done', 'position'],
  comments: ['author', 'body', 'created_at'],
  attachments: ['filename', 'original_name', 'size', 'mime', 'created_at']
};

const INT_COLS = new Set(['position', 'archived', 'starred', 'done', 'size']);

function normalizeCol(col, value) {
  if (INT_COLS.has(col)) return Number(value) || 0;
  if (col === 'due_date') return value || null;
  return value == null ? '' : String(value);
}

// SELECT a table's rows in wire shape. `maxRev` bounds the snapshot (cloud
// pull passes its high-water mark; the desktop's dirty scan doesn't need one).
function collectChanges(store, table, ownerId, sinceRev, maxRev = null) {
  const refCols = REFS[table].map((r, i) => `r${i}.uid AS ${r.as}`);
  const cols = COLS[table].map((c) => `t.${c}`);
  const joins = REFS[table].map((r, i) => `JOIN ${r.table} r${i} ON r${i}.id = t.${r.column}`);
  const select = ['t.uid', ...refCols, ...cols, 't.updated_at', 't.rev'].join(', ');
  let sql = `SELECT ${select} FROM ${table} t ${joins.join(' ')} WHERE t.owner_id = ? AND t.rev > ?`;
  const params = [ownerId, sinceRev];
  if (maxRev != null) {
    sql += ' AND t.rev <= ?';
    params.push(maxRev);
  }
  return store.all(`${sql} ORDER BY t.rev`, params);
}

// Apply one wire row. `serverSide` flips the tie-break (cloud keeps its own
// row on ties) and assigns a fresh rev from the store counter; the desktop
// applies with rev = -1 so the row doesn't count as locally dirty.
async function applyRow(t, table, row, ownerId, opts) {
  const uid = String(row.uid || '');
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return;
  const updatedAt = String(row.updated_at || '');
  if (updatedAt.length < 10) return;

  const refIds = {};
  for (const r of REFS[table]) {
    const parent = await t.one(
      `SELECT id FROM ${r.table} WHERE uid = ? AND owner_id = ?`,
      [String(row[r.as] || ''), ownerId]
    );
    // Rows travel parents-first; an unknown parent means it was deleted.
    if (!parent) return;
    refIds[r.column] = parent.id;
  }

  const existing = await t.one(`SELECT id, updated_at FROM ${table} WHERE uid = ? AND owner_id = ?`, [uid, ownerId]);
  if (existing) {
    const remoteNewer = updatedAt > existing.updated_at;
    const tie = updatedAt === existing.updated_at;
    if (!remoteNewer && !(tie && !opts.serverSide)) return;
    const rev = opts.serverSide ? await opts.nextRev(t) : -1;
    const sets = [];
    const params = [];
    for (const r of REFS[table]) { sets.push(`${r.column} = ?`); params.push(refIds[r.column]); }
    for (const c of COLS[table]) {
      if (c === 'created_at') continue;
      sets.push(`${c} = ?`);
      params.push(normalizeCol(c, row[c]));
    }
    sets.push('updated_at = ?', 'rev = ?');
    params.push(updatedAt, rev, existing.id);
    await t.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, params);
    return;
  }

  const rev = opts.serverSide ? await opts.nextRev(t) : -1;
  const cols = [...REFS[table].map((r) => r.column), ...COLS[table], 'uid', 'owner_id', 'updated_at', 'rev'];
  const params = [
    ...REFS[table].map((r) => refIds[r.column]),
    ...COLS[table].map((c) => normalizeCol(c, row[c])),
    uid, ownerId, updatedAt, rev
  ];
  await t.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params);
}

async function deleteByUid(t, table, uid, ownerId) {
  if (!SYNCABLE.includes(table)) return;
  await t.run(`DELETE FROM ${table} WHERE uid = ? AND owner_id = ?`, [String(uid || ''), ownerId]);
}

// ---------------------------------------------------------------------------
// Desktop client. Config lives in sync.json next to the database; cursors
// live in sync_state. The desktop works fully offline — a failed sync just
// flips the status to 'offline' and the next interval retries silently.
// ---------------------------------------------------------------------------

const INTERVAL_MS = 30 * 1000;

function createSyncClient({ store, dataDir }) {
  const settingsPath = path.join(dataDir, 'sync.json');
  const blobStatePath = path.join(dataDir, 'sync-blobs.json');
  const uploadsDir = path.join(dataDir, 'uploads');
  let cfg = null;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (saved && saved.url && saved.token) cfg = saved;
  } catch {}
  // uid → true for attachments whose bytes are on both sides already.
  let blobDone = {};
  try { blobDone = JSON.parse(fs.readFileSync(blobStatePath, 'utf8')); } catch {}
  let timer = null;
  let syncing = false;
  const state = { state: 'idle', lastSyncAt: null, lastError: null, pendingBlobs: 0 };

  const ownerId = () => store.localUser.id;

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
  }

  function status() {
    return {
      configured: !!cfg,
      url: cfg ? cfg.url : '',
      state: cfg ? state.state : 'idle',
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      pendingBlobs: state.pendingBlobs
    };
  }

  async function api(method, p, body) {
    const res = await fetch(cfg.url + p, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Sync request failed (${res.status})`);
    return json;
  }

  // Raw-bodied variant for blob up/downloads. Never throws on 4xx — those
  // are steady states (storage disabled, blob missing), not sync failures.
  async function blobReq(method, p, buf) {
    return fetch(cfg.url + p, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(buf !== undefined ? { 'content-type': 'application/octet-stream' } : {})
      },
      body: buf,
      signal: AbortSignal.timeout(60000)
    });
  }

  async function getCursor(k) {
    const row = await store.one('SELECT v FROM sync_state WHERE k = ?', [k]);
    // -1, not 0: legacy pre-sync rows carry rev 0 and must be picked up by
    // the first push; only cloud-applied rows (rev -1) are excluded.
    return row ? row.v : -1;
  }

  async function setCursor(k, v) {
    await store.run(
      'INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
      [k, v]
    );
  }

  // Push rows written locally since the last successful push (local rev >
  // cursor; rows applied from the cloud sit at rev -1 and are never pushed
  // back). The cursor advances to the highest rev actually sent, so a write
  // that lands mid-push is picked up by the next round instead of skipped.
  async function push() {
    const cursor = await getCursor('push_cursor');
    const changes = {};
    let maxRev = cursor;
    let count = 0;
    for (const table of SYNCABLE) {
      const rows = await collectChanges(store, table, ownerId(), cursor);
      if (!rows.length) continue;
      changes[table] = rows;
      count += rows.length;
      for (const r of rows) maxRev = Math.max(maxRev, r.rev);
    }
    const tombstones = await store.all(
      'SELECT tbl, uid, rev FROM sync_tombstones WHERE owner_id = ? AND rev > ? ORDER BY rev',
      [ownerId(), cursor]
    );
    for (const ts of tombstones) maxRev = Math.max(maxRev, ts.rev);
    if (!count && !tombstones.length) return;
    await api('POST', '/api/sync/push', {
      changes,
      tombstones: tombstones.map(({ tbl, uid }) => ({ tbl, uid }))
    });
    await setCursor('push_cursor', maxRev);
  }

  async function pull() {
    const since = await getCursor('pull_cursor');
    const body = await api('GET', `/api/sync/pull?since=${since}`);
    await store.tx(async (t) => {
      for (const table of SYNCABLE) {
        for (const row of body.changes?.[table] || []) {
          await applyRow(t, table, row, ownerId(), { serverSide: false });
        }
      }
      // Deletes apply children-first so a parent delete can't cascade away a
      // child whose own tombstone hasn't been applied yet.
      for (const table of [...SYNCABLE].reverse()) {
        for (const ts of (body.tombstones || []).filter((x) => x.tbl === table)) {
          await deleteByUid(t, table, ts.uid, ownerId());
        }
      }
    });
    await setCursor('pull_cursor', body.rev);
  }

  /* Blob exchange, after the metadata rounds: for every attachment row we
     know about, whichever side has the bytes shares them. Anything that
     can't move (storage disabled on the account, over the upload cap, blob
     missing on both sides) counts as pending and is retried next sync —
     blobs never flip the sync status to offline. */
  async function syncBlobs() {
    const rows = await store.all('SELECT uid, filename FROM attachments WHERE owner_id = ?', [ownerId()]);
    let pending = 0;
    let changed = false;
    for (const a of rows) {
      const local = path.join(uploadsDir, a.filename);
      const have = fs.existsSync(local);
      if (blobDone[a.uid] && have) continue;
      try {
        if (have) {
          const size = fs.statSync(local).size;
          const capMb = Number(cfg.maxUploadMb) || 25;
          if (size > capMb * 1024 * 1024) { pending++; continue; }
          const res = await blobReq('POST', `/api/sync/blob/${a.uid}`, fs.readFileSync(local));
          if (res.ok) { blobDone[a.uid] = true; changed = true; }
          else pending++; // 403 storage off, 413 over cap, 404 metadata not there yet
        } else {
          const res = await blobReq('GET', `/api/sync/blob/${a.uid}`);
          if (res.ok) {
            fs.mkdirSync(uploadsDir, { recursive: true });
            fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
            blobDone[a.uid] = true; changed = true;
          } else pending++;
        }
      } catch {
        pending++; // network blip — next interval retries
      }
    }
    // Forget uids whose rows are gone, then persist.
    const live = new Set(rows.map((r) => r.uid));
    blobDone = Object.fromEntries(Object.entries(blobDone).filter(([uid]) => live.has(uid)));
    if (changed) fs.writeFileSync(blobStatePath, JSON.stringify(blobDone));
    state.pendingBlobs = pending;
  }

  async function syncNow() {
    if (!cfg || syncing) return status();
    syncing = true;
    state.state = 'syncing';
    try {
      await push();
      await pull();
      await syncBlobs();
      state.state = 'idle';
      state.lastError = null;
      state.lastSyncAt = new Date().toISOString();
    } catch (err) {
      state.state = 'offline';
      state.lastError = err.message;
    } finally {
      syncing = false;
    }
    return status();
  }

  function start() {
    if (timer || !cfg) return;
    timer = setInterval(() => { syncNow().catch(() => {}); }, INTERVAL_MS);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    status,
    syncNow,
    start,
    stop,
    configured: () => !!cfg,
    async connect(url, token) {
      url = String(url || '').trim().replace(/\/+$/, '');
      token = String(token || '').trim();
      if (!url || !token) throw new Error('Server URL and API token are required');
      const trial = {
        url,
        token,
        deviceUid: crypto.randomUUID(),
        name: os.hostname().slice(0, 80) || 'Desktop',
        platform: process.platform
      };
      // Verify the credentials against the server before saving anything.
      cfg = trial;
      try {
        await api('POST', '/api/sync/hello', {
          device_uid: trial.deviceUid,
          name: trial.name,
          platform: trial.platform
        });
        // The blob uploader pre-checks against the server's upload cap.
        const me = await api('GET', '/api/me');
        trial.maxUploadMb = Number(me.maxUploadMb) || 25;
      } catch (err) {
        cfg = null;
        throw err;
      }
      save();
      start();
      await syncNow();
      return status();
    },
    async disconnect() {
      stop();
      cfg = null;
      try { fs.unlinkSync(settingsPath); } catch {}
      try { fs.unlinkSync(blobStatePath); } catch {}
      blobDone = {};
      state.pendingBlobs = 0;
      // A reconnect starts from a full pull rather than trusting stale cursors.
      await setCursor('pull_cursor', -1);
      await setCursor('push_cursor', -1);
      state.state = 'idle';
      state.lastSyncAt = null;
      state.lastError = null;
      return status();
    }
  };
}

module.exports = { createSyncClient, collectChanges, applyRow, deleteByUid, SYNC_ORDER: SYNCABLE, REFS, COLS };
