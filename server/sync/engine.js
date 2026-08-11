// Client-side sync engine. Pushes local changes (tracked by sync/track.js) to
// the sync server, pulls remote changes and applies them with per-entity
// last-writer-wins, then normalizes positions. Attachment bytes move
// separately, content-addressed by uuid.
//
// Merge rules (per entity, convergent across devices):
// - incoming non-deleted overwrites local only when incoming.updated_at >
//   local.updated_at (equal or older → no-op);
// - incoming tombstone deletes the local row unless the local row is newer —
//   then it stays (resurrection: it is still dirty, so the next push
//   re-uploads it and un-deletes it on the server);
// - rows whose parent uuid does not resolve locally are skipped silently
//   (orphans of a remotely deleted subtree);
// - after a pull batch, every touched list/board gets its children renumbered
//   densely by (position, updated_at, uuid) — deterministic on every device.

const path = require('path');
const fs = require('fs');
const {
  withTrackingSuppressed,
  getSyncMeta,
  setSyncMeta,
  listLocalChanges,
} = require('./track');
const { TABLE_ORDER, rowToPayload } = require('./serialize');

const FETCH_TIMEOUT_MS = 15000;
const SYNC_INTERVAL_MS = 30000;
const PULL_PAGE_SIZE = 500;

// Parent FK resolution: table → [local column, parent table, payload key].
const PARENTS = {
  boards: [],
  lists: [['board_id', 'boards', 'board_uuid']],
  cards: [['list_id', 'lists', 'list_uuid']],
  labels: [['board_id', 'boards', 'board_uuid']],
  card_labels: [
    ['card_id', 'cards', 'card_uuid'],
    ['label_id', 'labels', 'label_uuid'],
  ],
  checklists: [['card_id', 'cards', 'card_uuid']],
  checklist_items: [['checklist_id', 'checklists', 'checklist_uuid']],
  comments: [['card_id', 'cards', 'card_uuid']],
  attachments: [['card_id', 'cards', 'card_uuid']],
};

// Payload fields (parent uuids excluded — they become resolved FK columns).
const FIELDS = {
  boards: ['name', 'description', 'color', 'emoji', 'starred'],
  lists: ['name', 'position', 'archived'],
  cards: ['title', 'description', 'position', 'due_date', 'archived'],
  labels: ['name', 'color'],
  card_labels: [],
  checklists: ['title', 'position'],
  checklist_items: ['text', 'done', 'position'],
  comments: ['author', 'body', 'created_at'],
  attachments: ['original_name', 'size', 'mime', 'created_at'],
};

// Local storage name for a synced attachment: <uuid><ext from original_name>.
function attachmentFilename(uuid, originalName) {
  let ext = path.extname(String(originalName || '')).toLowerCase().slice(0, 12);
  if (!/^\.[a-z0-9]+$/.test(ext)) ext = '';
  return `${uuid}${ext}`;
}

function createSyncEngine({ db, uploadsDir }) {
  let inFlight = false;
  let timer = null;

  // ---- config / status ----

  function configure({ serverUrl, token }) {
    setSyncMeta(db, 'sync_server_url', String(serverUrl).replace(/\/+$/, ''));
    setSyncMeta(db, 'sync_token', String(token));
    setSyncMeta(db, 'sync_enabled', '1');
  }

  // Keeps cursor + last_push_at so re-enabling resumes where it left off.
  function disable() {
    setSyncMeta(db, 'sync_enabled', '0');
  }

  function isConfigured() {
    return (
      getSyncMeta(db, 'sync_enabled') === '1' &&
      !!getSyncMeta(db, 'sync_token') &&
      !!getSyncMeta(db, 'sync_server_url')
    );
  }

  function status() {
    const lastPushAt = Number(getSyncMeta(db, 'last_push_at') || 0);
    let account = null;
    try {
      account = JSON.parse(getSyncMeta(db, 'sync_account') || 'null');
    } catch {}
    return {
      enabled: getSyncMeta(db, 'sync_enabled') === '1',
      serverUrl: getSyncMeta(db, 'sync_server_url') || null,
      hasToken: !!getSyncMeta(db, 'sync_token'),
      account,
      lastSyncAt: Number(getSyncMeta(db, 'sync_last_sync_at') || 0) || null,
      lastError: getSyncMeta(db, 'sync_last_error') || null,
      pendingChanges: listLocalChanges(db, lastPushAt).length,
    };
  }

  // ---- HTTP helper (Bearer auth, 15s timeout, JSON error bodies) ----

  async function apiFetch(method, urlPath, opts = {}) {
    const serverUrl = getSyncMeta(db, 'sync_server_url');
    const token = getSyncMeta(db, 'sync_token');
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${serverUrl}${urlPath}`, {
        method,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.json ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers || {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
      });
      if (!res.ok) {
        let message = `Sync server error (${res.status})`;
        try {
          const body = await res.json();
          if (body && body.message) message = body.message;
          else if (body && body.error) message = body.error;
        } catch {}
        const err = new Error(message);
        err.status = res.status;
        throw err;
      }
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- push ----

  async function uploadAttachmentBytes(row) {
    let serverHasIt = true;
    try {
      await apiFetch('HEAD', `/api/sync/attachments/${row.uuid}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      serverHasIt = false;
    }
    if (serverHasIt) return; // bytes are immutable — never re-upload
    const buf = fs.readFileSync(path.join(uploadsDir, row.filename));
    await apiFetch('PUT', `/api/sync/attachments/${row.uuid}`, {
      body: buf,
      headers: { 'content-type': row.mime || 'application/octet-stream' },
    });
  }

  async function push() {
    const lastPushAt = Number(getSyncMeta(db, 'last_push_at') || 0);
    const changes = listLocalChanges(db, lastPushAt);
    if (!changes.length) return { accepted: 0, rejected: 0 };

    // Upload attachment bytes before the metadata push, so a peer that pulls
    // the row immediately after can always fetch the file.
    for (const c of changes) {
      if (c.table === 'attachments' && !c.deleted) {
        await uploadAttachmentBytes(c.row);
      }
    }

    const res = await apiFetch('POST', '/api/sync/push', {
      json: {
        changes: changes.map((c) => ({
          table: c.table,
          uuid: c.row.uuid,
          updated_at: c.row.updated_at,
          deleted: c.deleted,
          payload: c.deleted ? null : rowToPayload(db, c.table, c.row),
        })),
      },
    });
    const result = await res.json();

    // The server accepts every change newer-or-equal to what it stores, so
    // the max stamp we sent is a safe push watermark.
    const maxSent = Math.max(...changes.map((c) => c.row.updated_at));
    setSyncMeta(db, 'last_push_at', maxSent);
    db.prepare('DELETE FROM tombstones WHERE deleted_at <= ?').run(maxSent);
    return result;
  }

  // ---- pull + apply ----

  function resolveParents(table, payload) {
    const ids = {};
    for (const [column, parentTable, key] of PARENTS[table]) {
      const parent = db
        .prepare(`SELECT id FROM ${parentTable} WHERE uuid = ?`)
        .get(payload ? payload[key] : null);
      if (!parent) return null; // orphan of a remotely deleted subtree
      ids[column] = parent.id;
    }
    return ids;
  }

  // Applies one change. Must be called inside withTrackingSuppressed.
  // ctx: { listsTouched, boardsTouched, downloads } — collects follow-up work.
  function applyChange(change, ctx) {
    const { table, uuid, updated_at: updatedAt, deleted, payload } = change;
    const local = db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid);

    if (deleted) {
      if (!local) return; // already gone
      if (local.updated_at > updatedAt) return; // resurrect: local is newer
      if (table === 'attachments') {
        try { fs.unlinkSync(path.join(uploadsDir, local.filename)); } catch {}
      }
      if (table === 'cards') ctx.listsTouched.add(local.list_id);
      if (table === 'lists') ctx.boardsTouched.add(local.board_id);
      if (table === 'card_labels') {
        db.prepare('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?')
          .run(local.card_id, local.label_id);
      } else {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(local.id);
      }
      return;
    }

    if (!payload || typeof payload !== 'object') return;
    const parentIds = resolveParents(table, payload);
    if (!parentIds) return; // orphan — skip silently

    if (table === 'card_labels') {
      if (!local) {
        db.prepare(
          `INSERT OR IGNORE INTO card_labels (card_id, label_id, uuid, updated_at)
           VALUES (?, ?, ?, ?)`
        ).run(parentIds.card_id, parentIds.label_id, uuid, updatedAt);
      }
      return;
    }

    if (local) {
      if (table === 'cards') ctx.listsTouched.add(local.list_id);
      if (table === 'lists') ctx.boardsTouched.add(local.board_id);
      if (updatedAt <= local.updated_at) return; // LWW: local wins
      const fields = FIELDS[table];
      const assignments = [
        ...Object.keys(parentIds).map((col) => `${col} = ?`),
        ...fields.map((col) => `${col} = ?`),
        'updated_at = ?',
      ];
      const values = [
        ...Object.values(parentIds),
        ...fields.map((col) => payload[col]),
        updatedAt,
        local.id,
      ];
      db.prepare(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
      if (table === 'cards') ctx.listsTouched.add(parentIds.list_id);
      if (table === 'lists') ctx.boardsTouched.add(parentIds.board_id);
      if (table === 'attachments') ensureAttachmentFile(local, ctx);
      return;
    }

    // New row from a remote device.
    const columns = [...Object.keys(parentIds), ...FIELDS[table], 'uuid', 'updated_at'];
    const values = [
      ...Object.values(parentIds),
      ...FIELDS[table].map((col) => payload[col]),
      uuid,
      updatedAt,
    ];
    if (table === 'attachments') {
      columns.push('filename');
      values.push(attachmentFilename(uuid, payload.original_name));
    }
    const placeholders = columns.map(() => '?').join(', ');
    const info = db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...values);
    if (table === 'cards') ctx.listsTouched.add(parentIds.list_id);
    if (table === 'lists') ctx.boardsTouched.add(parentIds.board_id);
    if (table === 'attachments') {
      const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid);
      ensureAttachmentFile(row, ctx);
    }
  }

  // Queue a byte download when the local file is missing.
  function ensureAttachmentFile(row, ctx) {
    if (fs.existsSync(path.join(uploadsDir, row.filename))) return;
    ctx.downloads.push({ uuid: row.uuid, filename: row.filename });
  }

  // Deterministic renumbering of children after a pull batch. Runs inside the
  // suppressed block so renumbering doesn't dirty rows (peers run the same
  // sort after their own pulls and converge on the same dense positions).
  function normalizePositions(listsTouched, boardsTouched) {
    const updCard = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    for (const listId of listsTouched) {
      const cards = db
        .prepare(
          `SELECT id, position FROM cards
           WHERE list_id = ? ORDER BY position ASC, updated_at ASC, uuid ASC`
        )
        .all(listId);
      cards.forEach((c, i) => {
        if (c.position !== i) updCard.run(i, c.id);
      });
    }
    const updList = db.prepare('UPDATE lists SET position = ? WHERE id = ?');
    for (const boardId of boardsTouched) {
      const lists = db
        .prepare(
          `SELECT id, position FROM lists
           WHERE board_id = ? ORDER BY position ASC, updated_at ASC, uuid ASC`
        )
        .all(boardId);
      lists.forEach((l, i) => {
        if (l.position !== i) updList.run(i, l.id);
      });
    }
  }

  async function pull() {
    let cursor = Number(getSyncMeta(db, 'cursor') || 0);
    const all = [];
    for (;;) {
      const res = await apiFetch(
        'GET',
        `/api/sync/pull?cursor=${cursor}&limit=${PULL_PAGE_SIZE}`
      );
      const page = await res.json();
      all.push(...page.changes);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    if (!all.length) return 0;

    // Apply parents before children; Array#sort is stable, so seq order is
    // preserved within each table.
    const order = new Map(TABLE_ORDER.map((t, i) => [t, i]));
    const sorted = [...all].sort((a, b) => order.get(a.table) - order.get(b.table));

    const ctx = { listsTouched: new Set(), boardsTouched: new Set(), downloads: [] };
    withTrackingSuppressed(db, () => {
      db.transaction(() => {
        for (const change of sorted) applyChange(change, ctx);
        normalizePositions(ctx.listsTouched, ctx.boardsTouched);
      })();
    });

    for (const d of ctx.downloads) {
      try {
        const res = await apiFetch('GET', `/api/sync/attachments/${d.uuid}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(path.join(uploadsDir, d.filename), buf);
      } catch {
        // Bytes unavailable right now — the row stays and a later pull of an
        // update (or manual re-sync) retries the download.
      }
    }

    setSyncMeta(db, 'cursor', cursor);
    return all.length;
  }

  // ---- one full round ----

  // Returns undefined when sync is off/unconfigured (no-op), null on error
  // (captured into sync_last_error), or {accepted, rejected, pulled}.
  async function syncNow() {
    if (!isConfigured()) return undefined;
    if (inFlight) return null;
    inFlight = true;
    try {
      const pushResult = await push();
      const pulled = await pull();
      try {
        const res = await apiFetch('GET', '/api/account/status');
        setSyncMeta(db, 'sync_account', JSON.stringify(await res.json()));
      } catch {
        // Account info is best-effort; the error from push/pull (if any)
        // already carries the subscription message.
      }
      setSyncMeta(db, 'sync_last_sync_at', Date.now());
      setSyncMeta(db, 'sync_last_error', '');
      return { accepted: pushResult.accepted, rejected: pushResult.rejected, pulled };
    } catch (err) {
      // Cursor and last_push_at stay untouched — the next run retries.
      setSyncMeta(db, 'sync_last_error', err.message);
      return null;
    } finally {
      inFlight = false;
    }
  }

  // ---- interval driver ----

  function start() {
    if (timer) return;
    syncNow(); // immediate round on boot; no-ops when not configured
    timer = setInterval(() => {
      syncNow();
    }, SYNC_INTERVAL_MS);
    // Never keep the process alive just for sync (tests, CLI exits).
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { configure, disable, status, syncNow, start, stop };
}

module.exports = { createSyncEngine };
