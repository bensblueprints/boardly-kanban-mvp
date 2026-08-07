const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { openStore } = require('./data/index.js');
const mcpSettings = require('../mcp/settings.js');
const { startMcpHttp } = require('../mcp/http.js');
const coach = require('./coach.js');
const mailer = require('./mailer.js');

async function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD || 'admin';
  const autologinToken = opts.autologinToken || process.env.AUTOLOGIN_TOKEN || null;
  // Desktop mode passes a large cap: it's a local app writing to your own disk,
  // so installers and other big files can be attached. A shared/VPS install
  // keeps a conservative default that can still be raised via MAX_UPLOAD_MB.
  const maxUploadMb = Number(opts.maxUploadMb || process.env.MAX_UPLOAD_MB || 25);

  // One store for both engines: SQLite on the desktop, Postgres when
  // DATABASE_URL is set. Migrations run here, at startup (see server/data).
  const store = await openStore({ dataDir, databaseUrl: opts.databaseUrl, mode: opts.mode });

  const app = express();
  app.disable('x-powered-by');
  // Import payloads embed attachments as base64, so this tracks the upload cap
  // (plus headroom for base64's ~33% overhead) but stays bounded — a JSON body
  // is buffered in memory, so it must not follow a multi-GB upload cap.
  const jsonLimitMb = Math.min(Math.ceil(maxUploadMb * 1.4), 256);
  app.use(express.json({ limit: `${jsonLimitMb}mb` }));
  app.use(cookieParser());

  // Express 4 doesn't forward rejections from async handlers to the error
  // middleware — wrap them so a database error is a 500, not a hung request.
  const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- password hashing (scrypt, per-user salt, no new dependency) ----
  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }

  function verifyPassword(password, stored) {
    const [scheme, salt, hash] = String(stored || '').split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  }

  // ---- sessions (DB-backed: survive restarts, work on a shared server) ----
  async function newSession(res, userId, userAgent = '') {
    const sid = crypto.randomBytes(24).toString('hex');
    await store.run(
      'INSERT INTO sessions (token, user_id, user_agent, expires_at) VALUES (?, ?, ?, {{now+30d}})',
      [sid, userId, String(userAgent).slice(0, 300)]
    );
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    return sid;
  }

  function publicUser(u) {
    return u ? { id: u.id, email: u.email, name: u.name, plan: u.plan } : null;
  }

  // Either credential authenticates a request: the web app's session cookie,
  // or a Bearer API token (desktop sync and cloud MCP). A Bearer token is
  // checked first; an invalid one simply falls through to the cookie check.
  async function resolveUser(req) {
    const header = req.get('authorization') || '';
    if (header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token) {
        const row = await store.one(
          `SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id
           WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
          [crypto.createHash('sha256').update(token).digest('hex')]
        );
        if (row) {
          await store.run('UPDATE api_tokens SET last_used_at = {{now}} WHERE id = ?', [row.token_id]);
          return row;
        }
      }
    }
    const sid = req.cookies.sid;
    if (!sid) return null;
    return store.one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > {{now}}`,
      [sid]
    );
  }

  const requireAuth = h(async (req, res, next) => {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  });

  // ---- uploads ----
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  });
  const upload = multer({ storage, limits: { fileSize: maxUploadMb * 1024 * 1024 } });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

  // ---- helpers ----
  // Ownership derives through the board: boards carry owner_id and every child
  // row is reached by joining up to its board. In desktop mode the one local
  // user owns everything locally, so the same scoped queries pass through
  // unchanged — there is no separate desktop code path.
  const q = {
    board: 'SELECT * FROM boards WHERE id = ? AND owner_id = ?',
    list: `SELECT l.* FROM lists l JOIN boards b ON b.id = l.board_id
           WHERE l.id = ? AND b.owner_id = ?`,
    card: `SELECT c.* FROM cards c JOIN lists l ON l.id = c.list_id
           JOIN boards b ON b.id = l.board_id WHERE c.id = ? AND b.owner_id = ?`,
    label: `SELECT lb.* FROM labels lb JOIN boards b ON b.id = lb.board_id
            WHERE lb.id = ? AND b.owner_id = ?`,
    checklist: `SELECT cl.* FROM checklists cl
                JOIN cards c ON c.id = cl.card_id
                JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
                WHERE cl.id = ? AND b.owner_id = ?`,
    item: `SELECT ci.* FROM checklist_items ci
           JOIN checklists cl ON cl.id = ci.checklist_id
           JOIN cards c ON c.id = cl.card_id
           JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
           WHERE ci.id = ? AND b.owner_id = ?`,
    attachment: `SELECT a.* FROM attachments a
                 JOIN cards c ON c.id = a.card_id
                 JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
                 WHERE a.id = ? AND b.owner_id = ?`
  };

  // ---- sync bookkeeping ----
  // Every syncable row carries a UUID assigned once at creation, an updated_at
  // stamp, and a rev from a store-wide counter — the pull cursor the sync
  // engine replays from (see HANDOFF.md).
  async function nextRev(s = store) {
    return (await s.one("UPDATE sync_state SET v = v + 1 WHERE k = 'rev' RETURNING v")).v;
  }

  async function logActivity(boardId, cardId, action, detail = '') {
    await store.run('INSERT INTO activity (board_id, card_id, action, detail) VALUES (?, ?, ?, ?)',
      [boardId, cardId, action, detail]);
  }

  async function boardIdOfCard(cardId) {
    const row = await store.one(
      'SELECT l.board_id AS bid FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.id = ?',
      [cardId]
    );
    return row ? row.bid : null;
  }

  async function cardLabels(cardId) {
    return store.all(
      `SELECT lb.* FROM labels lb JOIN card_labels cl ON cl.label_id = lb.id
       WHERE cl.card_id = ? ORDER BY lb.id`,
      [cardId]
    );
  }

  async function checklistProgress(cardId) {
    const row = await store.one(
      `SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done
       FROM checklist_items ci JOIN checklists c ON c.id = ci.checklist_id
       WHERE c.card_id = ?`,
      [cardId]
    );
    return { total: row.total, done: row.done };
  }

  async function cardSummary(card) {
    const counts = await store.one(
      `SELECT
        (SELECT COUNT(*) FROM comments WHERE card_id = ?) AS comments,
        (SELECT COUNT(*) FROM attachments WHERE card_id = ?) AS attachments`,
      [card.id, card.id]
    );
    return {
      ...card,
      labels: await cardLabels(card.id),
      checklist: await checklistProgress(card.id),
      comment_count: counts.comments,
      attachment_count: counts.attachments,
      has_description: card.description.trim().length > 0
    };
  }

  async function cardDetail(card) {
    const checklists = [];
    for (const cl of await store.all('SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id', [card.id])) {
      checklists.push({
        ...cl,
        items: await store.all('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position, id', [cl.id])
      });
    }
    return {
      ...card,
      labels: await cardLabels(card.id),
      checklists,
      comments: await store.all('SELECT * FROM comments WHERE card_id = ? ORDER BY id DESC', [card.id]),
      attachments: await store.all('SELECT * FROM attachments WHERE card_id = ? ORDER BY id DESC', [card.id]),
      activity: await store.all('SELECT * FROM activity WHERE card_id = ? ORDER BY id DESC LIMIT 50', [card.id])
    };
  }

  // `s` lets a transaction pass its scoped store; plain calls use the pool.
  async function renumberList(listId, s = store) {
    const cards = await s.all('SELECT id FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id', [listId]);
    for (let i = 0; i < cards.length; i++) {
      await s.run('UPDATE cards SET position = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
        [i, await nextRev(s), cards[i].id]);
    }
  }

  // ================= AUTH =================

  // Registration is open and free for now (handoff decision), and cloud-only:
  // the desktop signs in as its one implicit local user and never shows a
  // login screen.
  if (store.mode === 'cloud') {
    app.post('/api/register', h(async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const name = String(req.body?.name || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const existing = await store.one('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(409).json({ error: 'That email is already registered' });
      const user = await store.one(
        `INSERT INTO users (uid, email, password_hash, name, plan, is_local)
         VALUES (?, ?, ?, ?, 'free', 0) RETURNING *`,
        [crypto.randomUUID(), email, hashPassword(password), name]
      );
      await newSession(res, user.id, req.get('user-agent'));
      res.json({ ok: true, user: publicUser(user) });
    }));
  }

  app.post('/api/login', h(async (req, res) => {
    if (store.mode === 'cloud') {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const user = await store.one('SELECT * FROM users WHERE email = ?', [email]);
      if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      await newSession(res, user.id, req.get('user-agent'));
      return res.json({ ok: true, user: publicUser(user) });
    }
    // Desktop mode: the existing single local password, bound to the one
    // implicit local user. No accounts, no registration, no login screen.
    const pw = String(req.body?.password || '');
    const a = Buffer.from(pw);
    const b = Buffer.from(adminPassword);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    await newSession(res, store.localUser.id, req.get('user-agent'));
    res.json({ ok: true });
  }));

  app.post('/api/logout', h(async (req, res) => {
    if (req.cookies.sid) await store.run('DELETE FROM sessions WHERE token = ?', [req.cookies.sid]);
    res.clearCookie('sid');
    res.json({ ok: true });
  }));

  app.get('/api/me', h(async (req, res) => {
    const user = await resolveUser(req);
    res.json({
      authed: !!user,
      user: publicUser(user),
      maxUploadMb,
      // Lets the frontend decide between the account screens (cloud) and the
      // desktop flow — the desktop app must never see a login screen.
      mode: store.mode
    });
  }));

  // desktop-mode auto-login
  if (autologinToken) {
    app.get('/auth/auto', h(async (req, res) => {
      if (req.query.token !== autologinToken) return res.status(403).send('Forbidden');
      await newSession(res, store.localUser.id, req.get('user-agent'));
      res.redirect('/');
    }));
  }

  // ================= API TOKENS (cloud only) =================
  // Long-lived credentials for desktop sync and cloud MCP. The full token is
  // shown once at creation; only its sha256 hash is stored. (A random
  // 192-bit token doesn't need password hashing — the hash exists so a
  // database leak doesn't hand out working credentials.)

  if (store.mode === 'cloud') {
    app.get('/api/tokens', requireAuth, h(async (req, res) => {
      res.json(await store.all(
        `SELECT id, name, prefix, scope, created_at, last_used_at FROM api_tokens
         WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC`,
        [req.user.id]
      ));
    }));

    app.post('/api/tokens', requireAuth, h(async (req, res) => {
      const name = String(req.body?.name || 'Token').trim() || 'Token';
      const token = crypto.randomBytes(24).toString('hex');
      const row = await store.one(
        `INSERT INTO api_tokens (uid, user_id, name, prefix, token_hash)
         VALUES (?, ?, ?, ?, ?) RETURNING id, name, prefix, scope, created_at`,
        [crypto.randomUUID(), req.user.id, name, token.slice(0, 8),
         crypto.createHash('sha256').update(token).digest('hex')]
      );
      // The only time the full token is ever returned.
      res.json({ ...row, token });
    }));

    app.delete('/api/tokens/:id', requireAuth, h(async (req, res) => {
      const row = await store.one(
        'SELECT id FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
        [req.params.id, req.user.id]
      );
      if (!row) return res.status(404).json({ error: 'Token not found' });
      await store.run('UPDATE api_tokens SET revoked_at = {{now}} WHERE id = ?', [row.id]);
      res.json({ ok: true });
    }));
  }

  // ================= BOARDS =================

  app.get('/api/boards', requireAuth, h(async (req, res) => {
    const boards = [];
    for (const b of await store.all('SELECT * FROM boards WHERE owner_id = ? ORDER BY starred DESC, id DESC', [req.user.id])) {
      const counts = await store.one(
        `SELECT
          (SELECT COUNT(*) FROM lists WHERE board_id = ? AND archived = 0) AS lists,
          (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id
            WHERE l.board_id = ? AND c.archived = 0 AND l.archived = 0) AS cards`,
        [b.id, b.id]
      );
      boards.push({ ...b, list_count: counts.lists, card_count: counts.cards });
    }
    res.json(boards);
  }));

  app.post('/api/boards', requireAuth, h(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Board name is required' });
    const color = String(req.body?.color || '#6366f1');
    const emoji = String(req.body?.emoji || '📋');
    const description = String(req.body?.description || '');
    const board = await store.one(
      `INSERT INTO boards (name, description, color, emoji, owner_id, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [name, description, color, emoji, req.user.id, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(board.id, null, 'board_created', `Created board "${name}"`);
    res.json(board);
  }));

  app.patch('/api/boards/:id', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : board.name;
    if (!name) return res.status(400).json({ error: 'Board name is required' });
    const color = req.body.color !== undefined ? String(req.body.color) : board.color;
    const emoji = req.body.emoji !== undefined ? String(req.body.emoji) : board.emoji;
    const starred = req.body.starred !== undefined ? (req.body.starred ? 1 : 0) : board.starred;
    const description = req.body.description !== undefined ? String(req.body.description) : board.description;
    await store.run(
      `UPDATE boards SET name = ?, description = ?, color = ?, emoji = ?, starred = ?,
         updated_at = {{now}}, rev = ? WHERE id = ?`,
      [name, description, color, emoji, starred, await nextRev(), board.id]);
    if (description !== board.description) await logActivity(board.id, null, 'board_description', 'Updated the project description');
    if (name !== board.name) await logActivity(board.id, null, 'board_renamed', `Renamed board to "${name}"`);
    res.json(await store.one(q.board, [board.id, req.user.id]));
  }));

  app.delete('/api/boards/:id', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    // clean up attachment files for the whole board
    const files = await store.all(
      `SELECT a.filename FROM attachments a JOIN cards c ON c.id = a.card_id
       JOIN lists l ON l.id = c.list_id WHERE l.board_id = ?`,
      [board.id]
    );
    await store.run('DELETE FROM boards WHERE id = ?', [board.id]);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    res.json({ ok: true });
  }));

  // full board fetch (non-archived lists+cards)
  app.get('/api/boards/:id', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const lists = [];
    for (const l of await store.all('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY position, id', [board.id])) {
      const cards = [];
      for (const c of await store.all('SELECT * FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id', [l.id])) {
        cards.push(await cardSummary(c));
      }
      lists.push({ ...l, cards });
    }
    const labels = await store.all('SELECT * FROM labels WHERE board_id = ? ORDER BY id', [board.id]);
    res.json({ ...board, lists, labels });
  }));

  app.get('/api/boards/:id/activity', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await store.all('SELECT * FROM activity WHERE board_id = ? ORDER BY id DESC LIMIT ?', [board.id, limit]));
  }));

  // archived items on a board (restorable)
  app.get('/api/boards/:id/archived', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const lists = await store.all('SELECT * FROM lists WHERE board_id = ? AND archived = 1 ORDER BY position, id', [board.id]);
    const cards = await store.all(
      `SELECT c.*, l.name AS list_name FROM cards c JOIN lists l ON l.id = c.list_id
       WHERE l.board_id = ? AND c.archived = 1 ORDER BY c.id DESC`,
      [board.id]
    );
    res.json({ lists, cards });
  }));

  // filter/search cards on a board: ?label=<id>&due=overdue|today|week|none&q=<text>
  app.get('/api/boards/:id/cards', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    let sql = `SELECT c.* FROM cards c JOIN lists l ON l.id = c.list_id
               WHERE l.board_id = ? AND c.archived = 0 AND l.archived = 0`;
    const params = [board.id];
    if (req.query.label) {
      sql += ' AND EXISTS (SELECT 1 FROM card_labels cl WHERE cl.card_id = c.id AND cl.label_id = ?)';
      params.push(Number(req.query.label));
    }
    if (req.query.q) {
      sql += ' AND (c.title {{ilike}} ? OR c.description {{ilike}} ?)';
      const like = `%${req.query.q}%`;
      params.push(like, like);
    }
    const due = req.query.due;
    if (due === 'overdue') sql += ' AND c.due_date IS NOT NULL AND c.due_date < {{now}}';
    else if (due === 'today') sql += ' AND c.due_date IS NOT NULL AND {{date(c.due_date)}} = {{today}}';
    else if (due === 'week') sql += ' AND c.due_date IS NOT NULL AND c.due_date >= {{now-1d}} AND c.due_date <= {{now+7d}}';
    else if (due === 'none') sql += ' AND c.due_date IS NULL';
    sql += ' ORDER BY l.position, c.position';
    const rows = await store.all(sql, params);
    const cards = [];
    for (const c of rows) cards.push(await cardSummary(c));
    res.json(cards);
  }));

  // ================= LISTS =================

  app.post('/api/boards/:id/lists', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const pos = (await store.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM lists WHERE board_id = ?', [board.id])).p;
    const list = await store.one(
      `INSERT INTO lists (board_id, name, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [board.id, name, pos, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(board.id, null, 'list_created', `Added list "${name}"`);
    res.json({ ...list, cards: [] });
  }));

  app.patch('/api/lists/:id', requireAuth, h(async (req, res) => {
    const list = await store.one(q.list, [req.params.id, req.user.id]);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : list.name;
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : list.archived;
    await store.run('UPDATE lists SET name = ?, archived = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [name, archived, await nextRev(), list.id]);
    if (archived !== list.archived) {
      await logActivity(list.board_id, null, archived ? 'list_archived' : 'list_restored',
        `${archived ? 'Archived' : 'Restored'} list "${name}"`);
    } else if (name !== list.name) {
      await logActivity(list.board_id, null, 'list_renamed', `Renamed list "${list.name}" to "${name}"`);
    }
    res.json(await store.one(q.list, [list.id, req.user.id]));
  }));

  // reorder lists on a board: { order: [listId, ...] }
  app.post('/api/boards/:id/lists/reorder', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!order) return res.status(400).json({ error: 'order array required' });
    await store.tx(async (t) => {
      for (let i = 0; i < order.length; i++) {
        await t.run('UPDATE lists SET position = ?, updated_at = {{now}}, rev = ? WHERE id = ? AND board_id = ?',
          [i, await nextRev(t), order[i], board.id]);
      }
    });
    res.json({ ok: true });
  }));

  // ================= CARDS =================

  app.post('/api/lists/:id/cards', requireAuth, h(async (req, res) => {
    const list = await store.one(q.list, [req.params.id, req.user.id]);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Card title is required' });
    const pos = (await store.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM cards WHERE list_id = ? AND archived = 0', [list.id])).p;
    const card = await store.one(
      `INSERT INTO cards (list_id, title, description, due_date, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [list.id, title, String(req.body?.description || ''), req.body?.due_date || null, pos,
       crypto.randomUUID(), await nextRev()]
    );
    await logActivity(list.board_id, card.id, 'card_created', `Added "${title}" to ${list.name}`);
    res.json(await cardSummary(card));
  }));

  app.get('/api/cards/:id', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json(await cardDetail(card));
  }));

  app.patch('/api/cards/:id', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const boardId = await boardIdOfCard(card.id);
    const title = req.body.title !== undefined ? String(req.body.title).trim() : card.title;
    if (!title) return res.status(400).json({ error: 'Card title is required' });
    const description = req.body.description !== undefined ? String(req.body.description) : card.description;
    const due = req.body.due_date !== undefined ? (req.body.due_date || null) : card.due_date;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : card.archived;
    await store.run(
      `UPDATE cards SET title = ?, description = ?, due_date = ?, archived = ?,
         updated_at = {{now}}, rev = ? WHERE id = ?`,
      [title, description, due, archived, await nextRev(), card.id]);
    if (archived !== card.archived) {
      await logActivity(boardId, card.id, archived ? 'card_archived' : 'card_restored',
        `${archived ? 'Archived' : 'Restored'} "${title}"`);
      await renumberList(card.list_id);
    } else {
      if (title !== card.title) await logActivity(boardId, card.id, 'card_renamed', `Renamed to "${title}"`);
      if (description !== card.description) await logActivity(boardId, card.id, 'card_description', 'Updated the description');
      if (due !== card.due_date) await logActivity(boardId, card.id, 'card_due', due ? `Set due date to ${due}` : 'Removed the due date');
    }
    res.json(await cardDetail(await store.one(q.card, [card.id, req.user.id])));
  }));

  app.delete('/api/cards/:id', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const boardId = await boardIdOfCard(card.id);
    const files = await store.all('SELECT filename FROM attachments WHERE card_id = ?', [card.id]);
    await store.run('DELETE FROM cards WHERE id = ?', [card.id]);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    await logActivity(boardId, null, 'card_deleted', `Deleted "${card.title}"`);
    res.json({ ok: true });
  }));

  // move card between/within lists: { list_id, position }
  app.post('/api/cards/:id/move', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const toList = await store.one(q.list, [Number(req.body?.list_id), req.user.id]);
    if (!toList) return res.status(404).json({ error: 'Target list not found' });
    const fromList = await store.one(q.list, [card.list_id, req.user.id]);
    const index = Math.max(0, Number(req.body?.position) || 0);

    await store.tx(async (t) => {
      // remaining cards in the target list (excluding the moving card), insert at index
      const targetCards = (await t.all(
        'SELECT id FROM cards WHERE list_id = ? AND archived = 0 AND id != ? ORDER BY position, id',
        [toList.id, card.id]
      )).map((c) => c.id);
      targetCards.splice(Math.min(index, targetCards.length), 0, card.id);
      await t.run('UPDATE cards SET list_id = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
        [toList.id, await nextRev(t), card.id]);
      for (let i = 0; i < targetCards.length; i++) {
        await t.run('UPDATE cards SET position = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
          [i, await nextRev(t), targetCards[i]]);
      }
      if (fromList.id !== toList.id) await renumberList(fromList.id, t);
    });

    if (fromList.id !== toList.id) {
      await logActivity(toList.board_id, card.id, 'card_moved', `Moved "${card.title}" from ${fromList.name} to ${toList.name}`);
    }
    res.json(await cardSummary(await store.one(q.card, [card.id, req.user.id])));
  }));

  // ================= LABELS =================

  app.post('/api/boards/:id/labels', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    const color = String(req.body?.color || '#22c55e');
    const label = await store.one(
      `INSERT INTO labels (board_id, name, color, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [board.id, name, color, crypto.randomUUID(), await nextRev()]
    );
    res.json(label);
  }));

  app.patch('/api/labels/:id', requireAuth, h(async (req, res) => {
    const label = await store.one(q.label, [req.params.id, req.user.id]);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : label.name;
    const color = req.body.color !== undefined ? String(req.body.color) : label.color;
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    await store.run('UPDATE labels SET name = ?, color = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [name, color, await nextRev(), label.id]);
    res.json(await store.one(q.label, [label.id, req.user.id]));
  }));

  app.delete('/api/labels/:id', requireAuth, h(async (req, res) => {
    const label = await store.one(q.label, [req.params.id, req.user.id]);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    await store.run('DELETE FROM labels WHERE id = ?', [label.id]);
    res.json({ ok: true });
  }));

  app.post('/api/cards/:id/labels/:labelId', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    const label = await store.one(q.label, [req.params.labelId, req.user.id]);
    if (!card || !label) return res.status(404).json({ error: 'Not found' });
    await store.run(
      `INSERT OR IGNORE INTO card_labels (card_id, label_id, uid, updated_at, rev)
       VALUES (?, ?, ?, {{now}}, ?)`,
      [card.id, label.id, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(label.board_id, card.id, 'label_added', `Added label "${label.name}" to "${card.title}"`);
    res.json({ ok: true, labels: await cardLabels(card.id) });
  }));

  app.delete('/api/cards/:id/labels/:labelId', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    await store.run('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?', [card.id, Number(req.params.labelId)]);
    res.json({ ok: true, labels: await cardLabels(card.id) });
  }));

  // ================= CHECKLISTS =================

  app.post('/api/cards/:id/checklists', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const title = String(req.body?.title || 'Checklist').trim() || 'Checklist';
    const pos = (await store.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklists WHERE card_id = ?', [card.id])).p;
    const row = await store.one(
      `INSERT INTO checklists (card_id, title, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING id`,
      [card.id, title, pos, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(await boardIdOfCard(card.id), card.id, 'checklist_added', `Added checklist "${title}"`);
    res.json({ id: row.id, card_id: card.id, title, position: pos, items: [] });
  }));

  app.patch('/api/checklists/:id', requireAuth, h(async (req, res) => {
    const cl = await store.one(q.checklist, [req.params.id, req.user.id]);
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });
    const title = String(req.body?.title || cl.title).trim() || cl.title;
    await store.run('UPDATE checklists SET title = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [title, await nextRev(), cl.id]);
    res.json({ ok: true });
  }));

  app.delete('/api/checklists/:id', requireAuth, h(async (req, res) => {
    const cl = await store.one(q.checklist, [req.params.id, req.user.id]);
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });
    await store.run('DELETE FROM checklists WHERE id = ?', [cl.id]);
    res.json({ ok: true });
  }));

  app.post('/api/checklists/:id/items', requireAuth, h(async (req, res) => {
    const cl = await store.one(q.checklist, [req.params.id, req.user.id]);
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const pos = (await store.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklist_items WHERE checklist_id = ?', [cl.id])).p;
    const item = await store.one(
      `INSERT INTO checklist_items (checklist_id, text, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [cl.id, text, pos, crypto.randomUUID(), await nextRev()]
    );
    res.json(item);
  }));

  app.patch('/api/checklist-items/:id', requireAuth, h(async (req, res) => {
    const item = await store.one(q.item, [req.params.id, req.user.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const text = req.body.text !== undefined ? String(req.body.text).trim() : item.text;
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : item.done;
    await store.run('UPDATE checklist_items SET text = ?, done = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [text, done, await nextRev(), item.id]);
    if (done !== item.done && done) {
      const cl = await store.one('SELECT * FROM checklists WHERE id = ?', [item.checklist_id]);
      await logActivity(await boardIdOfCard(cl.card_id), cl.card_id, 'item_completed', `Completed "${text}"`);
    }
    const cl = await store.one('SELECT * FROM checklists WHERE id = ?', [item.checklist_id]);
    res.json({
      ...await store.one(q.item, [item.id, req.user.id]),
      progress: await checklistProgress(cl.card_id)
    });
  }));

  app.delete('/api/checklist-items/:id', requireAuth, h(async (req, res) => {
    await store.run(
      `DELETE FROM checklist_items WHERE id = ? AND EXISTS (
         SELECT 1 FROM checklists cl
         JOIN cards c ON c.id = cl.card_id
         JOIN lists l ON l.id = c.list_id
         JOIN boards b ON b.id = l.board_id
         WHERE cl.id = checklist_items.checklist_id AND b.owner_id = ?)`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  }));

  // ================= COMMENTS =================

  app.post('/api/cards/:id/comments', requireAuth, h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment body is required' });
    const author = String(req.body?.author || 'Admin').trim() || 'Admin';
    const comment = await store.one(
      `INSERT INTO comments (card_id, author, body, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [card.id, author, body, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(await boardIdOfCard(card.id), card.id, 'comment_added', `Commented on "${card.title}"`);
    res.json(comment);
  }));

  app.delete('/api/comments/:id', requireAuth, h(async (req, res) => {
    await store.run(
      `DELETE FROM comments WHERE id = ? AND EXISTS (
         SELECT 1 FROM cards c
         JOIN lists l ON l.id = c.list_id
         JOIN boards b ON b.id = l.board_id
         WHERE c.id = comments.card_id AND b.owner_id = ?)`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  }));

  // ================= ATTACHMENTS =================

  app.post('/api/cards/:id/attachments', requireAuth, upload.single('file'), h(async (req, res) => {
    const card = await store.one(q.card, [req.params.id, req.user.id]);
    if (!card) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Card not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const row = await store.one(
      `INSERT INTO attachments (card_id, filename, original_name, size, mime, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [card.id, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype,
       crypto.randomUUID(), await nextRev()]
    );
    await logActivity(await boardIdOfCard(card.id), card.id, 'attachment_added', `Attached ${req.file.originalname}`);
    res.json({ ...row, url: `/uploads/${row.filename}` });
  }));

  app.delete('/api/attachments/:id', requireAuth, h(async (req, res) => {
    const row = await store.one(q.attachment, [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    await store.run('DELETE FROM attachments WHERE id = ?', [row.id]);
    try { fs.unlinkSync(path.join(uploadsDir, row.filename)); } catch {}
    res.json({ ok: true });
  }));

  // ================= EXPORT / IMPORT =================

  app.get('/api/boards/:id/export', requireAuth, h(async (req, res) => {
    const board = await store.one(q.board, [req.params.id, req.user.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const labels = await store.all('SELECT * FROM labels WHERE board_id = ? ORDER BY id', [board.id]);
    const lists = [];
    for (const l of await store.all('SELECT * FROM lists WHERE board_id = ? ORDER BY position, id', [board.id])) {
      const cards = [];
      for (const c of await store.all('SELECT * FROM cards WHERE list_id = ? ORDER BY position, id', [l.id])) {
        const checklists = [];
        for (const cl of await store.all('SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id', [c.id])) {
          checklists.push({
            title: cl.title,
            items: (await store.all('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position, id', [cl.id]))
              .map((i) => ({ text: i.text, done: i.done }))
          });
        }
        const comments = (await store.all('SELECT * FROM comments WHERE card_id = ? ORDER BY id', [c.id]))
          .map((cm) => ({ author: cm.author, body: cm.body, created_at: cm.created_at }));
        const attachments = [];
        for (const a of await store.all('SELECT * FROM attachments WHERE card_id = ? ORDER BY id', [c.id])) {
          let data = null;
          try { data = fs.readFileSync(path.join(uploadsDir, a.filename)).toString('base64'); } catch {}
          attachments.push({ original_name: a.original_name, mime: a.mime, size: a.size, data });
        }
        cards.push({
          title: c.title,
          description: c.description,
          position: c.position,
          due_date: c.due_date,
          archived: c.archived,
          created_at: c.created_at,
          labels: (await cardLabels(c.id)).map((lb) => lb.name),
          checklists,
          comments,
          attachments
        });
      }
      lists.push({
        name: l.name,
        position: l.position,
        archived: l.archived,
        cards
      });
    }
    const payload = {
      app: 'boardly',
      version: 1,
      exported_at: new Date().toISOString(),
      board: { name: board.name, description: board.description, color: board.color, emoji: board.emoji, starred: board.starred },
      labels: labels.map((lb) => ({ name: lb.name, color: lb.color })),
      lists
    };
    res.setHeader('Content-Disposition', `attachment; filename="${board.name.replace(/[^\w\- ]+/g, '')}-boardly-export.json"`);
    res.json(payload);
  }));

  app.post('/api/boards/import', requireAuth, h(async (req, res) => {
    const data = req.body;
    if (!data || data.app !== 'boardly' || !data.board || !Array.isArray(data.lists)) {
      return res.status(400).json({ error: 'Not a valid Boardly export file' });
    }
    let boardId;
    const pendingFiles = []; // written after the transaction commits
    await store.tx(async (t) => {
      const b = data.board;
      boardId = (await t.one(
        `INSERT INTO boards (name, description, color, emoji, starred, owner_id, uid, updated_at, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING id`,
        [String(b.name || 'Imported board'), String(b.description || ''), String(b.color || '#6366f1'), String(b.emoji || '📋'), b.starred ? 1 : 0,
         req.user.id, crypto.randomUUID(), await nextRev(t)]
      )).id;
      const labelIds = {};
      for (const lb of data.labels || []) {
        labelIds[lb.name] = (await t.one(
          `INSERT INTO labels (board_id, name, color, uid, updated_at, rev)
           VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING id`,
          [boardId, String(lb.name), String(lb.color || '#22c55e'), crypto.randomUUID(), await nextRev(t)]
        )).id;
      }
      for (const l of data.lists) {
        const listId = (await t.one(
          `INSERT INTO lists (board_id, name, position, archived, uid, updated_at, rev)
           VALUES (?, ?, ?, ?, ?, {{now}}, ?) RETURNING id`,
          [boardId, String(l.name), Number(l.position) || 0, l.archived ? 1 : 0,
           crypto.randomUUID(), await nextRev(t)]
        )).id;
        for (const c of l.cards || []) {
          const cardId = (await t.one(
            `INSERT INTO cards (list_id, title, description, position, due_date, archived, uid, updated_at, rev)
             VALUES (?, ?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING id`,
            [listId, String(c.title), String(c.description || ''), Number(c.position) || 0,
             c.due_date || null, c.archived ? 1 : 0, crypto.randomUUID(), await nextRev(t)]
          )).id;
          for (const name of c.labels || []) {
            if (labelIds[name]) {
              await t.run(
                'INSERT OR IGNORE INTO card_labels (card_id, label_id, uid, updated_at, rev) VALUES (?, ?, ?, {{now}}, ?)',
                [cardId, labelIds[name], crypto.randomUUID(), await nextRev(t)]
              );
            }
          }
          for (const [cli, cl] of (c.checklists || []).entries()) {
            const clId = (await t.one(
              `INSERT INTO checklists (card_id, title, position, uid, updated_at, rev)
               VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING id`,
              [cardId, String(cl.title || 'Checklist'), cli, crypto.randomUUID(), await nextRev(t)]
            )).id;
            for (const [ii, it] of (cl.items || []).entries()) {
              await t.run(
                `INSERT INTO checklist_items (checklist_id, text, done, position, uid, updated_at, rev)
                 VALUES (?, ?, ?, ?, ?, {{now}}, ?)`,
                [clId, String(it.text), it.done ? 1 : 0, ii, crypto.randomUUID(), await nextRev(t)]
              );
            }
          }
          for (const cm of c.comments || []) {
            await t.run(
              `INSERT INTO comments (card_id, author, body, created_at, uid, updated_at, rev)
               VALUES (?, ?, ?, ?, ?, {{now}}, ?)`,
              [cardId, String(cm.author || 'Admin'), String(cm.body), cm.created_at || new Date().toISOString(),
               crypto.randomUUID(), await nextRev(t)]
            );
          }
          for (const a of c.attachments || []) {
            if (!a || !a.data) continue;
            const ext = (path.extname(a.original_name || '') || '').toLowerCase().slice(0, 12);
            const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
            const buf = Buffer.from(a.data, 'base64');
            await t.run(
              `INSERT INTO attachments (card_id, filename, original_name, size, mime, uid, updated_at, rev)
               VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?)`,
              [cardId, filename, String(a.original_name || filename), buf.length, String(a.mime || 'application/octet-stream'),
               crypto.randomUUID(), await nextRev(t)]
            );
            pendingFiles.push({ filename, buf });
          }
        }
      }
      await t.run(
        'INSERT INTO activity (board_id, card_id, action, detail) VALUES (?, NULL, ?, ?)',
        [boardId, 'board_imported', `Imported board "${b.name}"`]
      );
    });
    for (const f of pendingFiles) fs.writeFileSync(path.join(uploadsDir, f.filename), f.buf);
    res.json(await store.one(q.board, [boardId, req.user.id]));
  }));

  // Turn multer's size rejection into a clear message naming the actual cap,
  // instead of a bare 500.
  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File is too large — the limit is ${maxUploadMb} MB` });
    }
    if (err) return res.status(500).json({ error: err.message || 'Upload failed' });
    next();
  });

  // ================= VOICE COACH (desktop only) =================
  // Asks a local LLM "what should I do next", grounded in the actual board.
  // Model + speech-to-text both run on your own hardware, so this is wired up
  // in desktop mode only — it isn't coherent per-user on a shared server.
  // coach.js keeps the sync better-sqlite3 path (store.raw); see HANDOFF.md.

  if (store.mode === 'desktop') {
    const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

    app.get('/api/coach', requireAuth, (req, res) => {
      res.json(coach.readSettings(dataDir));
    });

    app.post('/api/coach/settings', requireAuth, (req, res) => {
      const allowed = ['chatUrl', 'chatModel', 'sttUrl', 'sttModel', 'apiKey', 'enabled'];
      const patch = {};
      for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
      res.json(coach.writeSettings(dataDir, patch));
    });

    app.post('/api/coach/probe', requireAuth, async (req, res) => {
      try {
        // Probe whatever is in the form right now, not just what's saved — so
        // "Test" works before you've hit Save.
        const settings = { ...coach.readSettings(dataDir) };
        for (const k of ['chatUrl', 'chatModel', 'sttUrl', 'sttModel', 'apiKey']) {
          if (req.body?.[k] !== undefined) settings[k] = req.body[k];
        }
        res.json(await coach.probe(settings));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Model list for the dropdown, fetched live from the server being configured.
    app.post('/api/coach/models', requireAuth, async (req, res) => {
      const settings = coach.readSettings(dataDir);
      const url = req.body?.url || settings.chatUrl;
      try {
        res.json({ models: await coach.listModels(url, req.body?.apiKey ?? settings.apiKey) });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    app.post('/api/coach/transcribe', requireAuth, audioUpload.single('audio'), async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
      try {
        const text = await coach.transcribe({
          settings: coach.readSettings(dataDir),
          buffer: req.file.buffer,
          filename: req.file.originalname || 'speech.webm',
          mime: req.file.mimetype
        });
        res.json({ text });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Ask the coach what to do next. Returns the chosen card plus concrete steps.
    app.post('/api/coach/next', requireAuth, async (req, res) => {
      const settings = coach.readSettings(dataDir);
      const boardId = req.body?.board_id ? Number(req.body.board_id) : undefined;
      const question = String(req.body?.question || 'What should I work on next?');
      const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];

      try {
        const context = coach.buildContext(store.raw, { boardId });
        const chosen = coach.pickCard(context);
        if (!chosen) {
          return res.json({ plan: null, say: 'Nothing outstanding on this board — everything is ticked off.' });
        }

        // Only the chosen card goes to the model. A small local model handed 60
        // similar objects starts mirroring them instead of reasoning.
        const messages = [
          { role: 'system', content: coach.SYSTEM_PROMPT },
          ...history.filter((m) => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
            .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
          {
            role: 'user',
            // The full card — description, checklist, comments, attachments — so
            // the model works from what's actually written on it rather than
            // guessing from the title.
            content: coach.renderCardBrief(coach.buildCardBrief(store.raw, chosen.card_id), question)
          }
        ];
        const raw = await coach.chat({ settings, messages, json: true, schema: coach.PLAN_SCHEMA });
        const plan = coach.normalisePlan(coach.extractJson(raw));
        if (!plan) {
          // The model answered but not in the shape we asked for — surface what it
          // said rather than pretending it failed entirely.
          return res.json({ plan: null, raw, say: String(raw || '').slice(0, 400) });
        }
        // card_id comes from our own pick, so it can never be a hallucinated id.
        res.json({
          plan: {
            card_id: chosen.card_id,
            card_title: chosen.title,
            why: plan.why,
            steps: plan.steps,
            say: plan.say
          }
        });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Write the coach's steps onto the card as a real checklist.
    app.post('/api/coach/apply', requireAuth, h(async (req, res) => {
      const cardId = Number(req.body?.card_id);
      const steps = Array.isArray(req.body?.steps) ? req.body.steps.map(String).filter(Boolean) : [];
      const title = String(req.body?.title || 'Next up').slice(0, 80);
      const card = await store.one(q.card, [cardId, req.user.id]);
      if (!card) return res.status(404).json({ error: 'Card not found' });
      if (!steps.length) return res.status(400).json({ error: 'No steps to add' });

      const pos = (await store.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklists WHERE card_id = ?', [card.id])).p;
      const row = await store.one(
        `INSERT INTO checklists (card_id, title, position, uid, updated_at, rev)
         VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING id`,
        [card.id, title, pos, crypto.randomUUID(), await nextRev()]
      );
      for (let i = 0; i < steps.length; i++) {
        await store.run(
          'INSERT INTO checklist_items (checklist_id, text, position, uid, updated_at, rev) VALUES (?, ?, ?, ?, {{now}}, ?)',
          [row.id, steps[i].slice(0, 500), i, crypto.randomUUID(), await nextRev()]);
      }
      await logActivity(await boardIdOfCard(card.id), card.id, 'checklist_added', `Coach added "${title}"`);
      res.json({ ok: true, checklist_id: row.id, count: steps.length });
    }));
  }

  /* ---- email: due-date reminders + weekly digest -------------------------
     Entirely optional. Boardly is fully functional with this switched off —
     it is a connected feature (it needs a machine awake when you are not),
     not a piece of the app held back behind a paywall. */

  app.get('/api/mail', requireAuth, (req, res) => {
    const s = mailer.readSettings(dataDir);
    // Never hand the key back to the browser; just say whether one is set.
    res.json({ ...s, apiKey: s.apiKey ? '••••••••' : '', hasApiKey: Boolean(s.apiKey) });
  });

  app.post('/api/mail/settings', requireAuth, (req, res) => {
    const allowed = ['enabled', 'apiKey', 'from', 'to', 'dueReminders', 'dueLookaheadDays',
      'weeklyDigest', 'digestWeekday', 'sendHour', 'siteUrl'];
    const patch = {};
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
    // A masked key means "leave it alone", not "set it to bullets".
    if (typeof patch.apiKey === 'string' && /^•+$/.test(patch.apiKey)) delete patch.apiKey;
    const next = mailer.writeSettings(dataDir, patch);
    res.json({ ...next, apiKey: next.apiKey ? '••••••••' : '', hasApiKey: Boolean(next.apiKey) });
  });

  app.post('/api/mail/probe', requireAuth, async (req, res) => {
    try {
      // Test what's in the form right now, so "Send test" works before Save.
      const settings = { ...mailer.readSettings(dataDir) };
      for (const k of ['apiKey', 'from', 'to']) {
        if (req.body?.[k] !== undefined && !/^•+$/.test(String(req.body[k]))) settings[k] = req.body[k];
      }
      res.json(await mailer.probe(settings));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // What a reminder would say right now, without sending it. Scoped to the
  // caller's own boards, like every other read.
  app.get('/api/mail/preview', requireAuth, h(async (req, res) => {
    const s = mailer.readSettings(dataDir);
    const cards = await mailer.dueCards(store, Number(s.dueLookaheadDays) || 0, req.user.id);
    const activity = await mailer.recentActivity(store, 7, req.user.id);
    res.json({
      due: cards.length ? mailer.renderDue(cards, s) : null,
      dueCount: cards.length,
      digest: mailer.renderDigest(activity, 7),
      activityCount: activity.length
    });
  }));

  app.post('/api/mail/run', requireAuth, h(async (req, res) => {
    try {
      res.json(await mailer.runOnce(store, dataDir, { force: req.body?.force === true, ownerId: req.user.id }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }));

  // ================= MCP INTEGRATION (desktop only) =================
  // Lets an AI client (Claude Code / Claude Desktop) read and write these
  // boards. Served on its own fixed 127.0.0.1 port so the endpoint URL
  // survives restarts — see mcp/http.js for why. That is single-tenant by
  // design, so it is wired up in desktop mode only; the cloud mount lands
  // with token auth in a later task (see HANDOFF.md).

  let mcpHandle = null;
  let mcpError = null;

  if (store.mode === 'desktop') {

    async function startMcp(port) {
      if (mcpHandle) return mcpHandle;
      const settings = mcpSettings.readSettings(dataDir);
      const usePort = port || settings.port;
      const handle = await startMcpHttp({ db: store, uploadsDir, port: usePort, token: settings.token });
      mcpHandle = handle;
      mcpError = null;
      mcpSettings.writeSettings(dataDir, { ...settings, enabled: true, port: handle.port });
      return handle;
    }

    // Close the listener but leave settings alone — used on app quit, so an
    // enabled integration still autostarts on the next launch.
    async function shutdownMcp() {
      if (mcpHandle) {
        await mcpHandle.close();
        mcpHandle = null;
      }
    }

    // User-initiated stop: also clears `enabled` so it stays off after a restart.
    async function stopMcp() {
      await shutdownMcp();
      const settings = mcpSettings.readSettings(dataDir);
      mcpSettings.writeSettings(dataDir, { ...settings, enabled: false });
    }

    function mcpStatus() {
      const settings = mcpSettings.readSettings(dataDir);
      return {
        enabled: settings.enabled,
        running: !!mcpHandle,
        port: mcpHandle ? mcpHandle.port : settings.port,
        url: mcpSettings.endpointUrl(mcpHandle ? mcpHandle.port : settings.port),
        token: settings.token,
        error: mcpError,
        config: { mcpServers: { [mcpSettings.SERVER_KEY]: mcpSettings.clientConfigEntry(settings) } },
        clients: mcpSettings.clientStatus(settings)
      };
    }

    // Called by the desktop/server entrypoints on boot.
    app.startMcpIfEnabled = async () => {
      const settings = mcpSettings.readSettings(dataDir);
      if (!settings.enabled) return null;
      try {
        return await startMcp(settings.port);
      } catch (err) {
        mcpError = err.message;
        console.error('MCP autostart failed:', err.message);
        return null;
      }
    };
    app.stopMcp = stopMcp;
    app.shutdownMcp = shutdownMcp;

    app.get('/api/mcp', requireAuth, (req, res) => res.json(mcpStatus()));

    app.post('/api/mcp/start', requireAuth, async (req, res) => {
      const port = req.body?.port !== undefined ? Number(req.body.port) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
        return res.status(400).json({ error: 'Port must be an integer between 1024 and 65535' });
      }
      try {
        await startMcp(port);
        res.json(mcpStatus());
      } catch (err) {
        mcpError = err.message;
        res.status(400).json({ error: err.message });
      }
    });

    app.post('/api/mcp/stop', requireAuth, async (req, res) => {
      try {
        await stopMcp();
        res.json(mcpStatus());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Rotating the token invalidates every client — they must be reconnected.
    app.post('/api/mcp/token', requireAuth, async (req, res) => {
      const settings = mcpSettings.readSettings(dataDir);
      const next = mcpSettings.writeSettings(dataDir, {
        ...settings,
        token: crypto.randomBytes(24).toString('hex')
      });
      const wasRunning = !!mcpHandle;
      if (wasRunning) {
        await stopMcp();
        try {
          await startMcp(next.port);
        } catch (err) {
          mcpError = err.message;
        }
      }
      res.json(mcpStatus());
    });

    app.post('/api/mcp/connect', requireAuth, (req, res) => {
      const client = String(req.body?.client || '');
      try {
        const settings = mcpSettings.readSettings(dataDir);
        const result = mcpSettings.connectClient(client, {
          port: mcpHandle ? mcpHandle.port : settings.port,
          token: settings.token
        });
        res.json({ ...result, status: mcpStatus() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

  } else {
    // Cloud mode: no local MCP listener to manage.
    app.startMcpIfEnabled = async () => null;
    app.stopMcp = async () => {};
    app.shutdownMcp = async () => {};
  }

  // ================= FRONTEND =================

  const distDir = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api|uploads|auth).*/, (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  /* Hourly check for due-date reminders and the weekly digest. runOnce()
     decides whether anything is actually due and records what it sent, so a
     restart cannot produce a second reminder on the same day. unref() so this
     never holds the process open. In desktop mode the check is scoped to the
     local user (who owns everything locally); on a shared server the
     scheduler-level run is operator config and spans all boards. */
  app.startMailScheduler = () => {
    const settings = mailer.readSettings(dataDir);
    if (!settings.enabled) return null;
    const ownerId = store.localUser ? store.localUser.id : null;
    const tick = () => {
      mailer.runOnce(store, dataDir, { ownerId }).catch((err) => console.log('mail check failed:', err.message));
    };
    const timer = setInterval(tick, 60 * 60 * 1000);
    timer.unref();
    setTimeout(tick, 30 * 1000).unref?.();   // one check shortly after boot
    return timer;
  };

  return app;
}

module.exports = { createApp };
