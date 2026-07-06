const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { openDb } = require('./db');

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD || 'admin';
  const autologinToken = opts.autologinToken || process.env.AUTOLOGIN_TOKEN || null;

  const db = openDb(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' })); // import payloads can embed attachments
  app.use(cookieParser());

  // ---- sessions (in-memory, simple by design) ----
  const sessions = new Set();
  function newSession(res) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    return sid;
  }
  function requireAuth(req, res, next) {
    if (req.cookies.sid && sessions.has(req.cookies.sid)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  }

  // ---- uploads ----
  const uploadsDir = path.join(dataDir, 'uploads');
  const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  });
  const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

  // ---- helpers ----
  const q = {
    board: db.prepare('SELECT * FROM boards WHERE id = ?'),
    list: db.prepare('SELECT * FROM lists WHERE id = ?'),
    card: db.prepare('SELECT * FROM cards WHERE id = ?'),
    label: db.prepare('SELECT * FROM labels WHERE id = ?')
  };

  function logActivity(boardId, cardId, action, detail = '') {
    db.prepare('INSERT INTO activity (board_id, card_id, action, detail) VALUES (?, ?, ?, ?)')
      .run(boardId, cardId, action, detail);
  }

  function boardIdOfCard(cardId) {
    const row = db.prepare(
      'SELECT l.board_id AS bid FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.id = ?'
    ).get(cardId);
    return row ? row.bid : null;
  }

  function cardLabels(cardId) {
    return db.prepare(
      `SELECT lb.* FROM labels lb JOIN card_labels cl ON cl.label_id = lb.id
       WHERE cl.card_id = ? ORDER BY lb.id`
    ).all(cardId);
  }

  function checklistProgress(cardId) {
    const row = db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done
       FROM checklist_items ci JOIN checklists c ON c.id = ci.checklist_id
       WHERE c.card_id = ?`
    ).get(cardId);
    return { total: row.total, done: row.done };
  }

  function cardSummary(card) {
    const counts = db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM comments WHERE card_id = @id) AS comments,
        (SELECT COUNT(*) FROM attachments WHERE card_id = @id) AS attachments`
    ).get({ id: card.id });
    return {
      ...card,
      labels: cardLabels(card.id),
      checklist: checklistProgress(card.id),
      comment_count: counts.comments,
      attachment_count: counts.attachments,
      has_description: card.description.trim().length > 0
    };
  }

  function cardDetail(card) {
    const checklists = db.prepare('SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id')
      .all(card.id)
      .map((cl) => ({
        ...cl,
        items: db.prepare('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position, id').all(cl.id)
      }));
    return {
      ...card,
      labels: cardLabels(card.id),
      checklists,
      comments: db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY id DESC').all(card.id),
      attachments: db.prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY id DESC').all(card.id),
      activity: db.prepare('SELECT * FROM activity WHERE card_id = ? ORDER BY id DESC LIMIT 50').all(card.id)
    };
  }

  function renumberList(listId) {
    const cards = db.prepare('SELECT id FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id').all(listId);
    const upd = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    cards.forEach((c, i) => upd.run(i, c.id));
  }

  // ================= AUTH =================

  app.post('/api/login', (req, res) => {
    const pw = String(req.body?.password || '');
    const a = Buffer.from(pw);
    const b = Buffer.from(adminPassword);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    newSession(res);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    sessions.delete(req.cookies.sid);
    res.clearCookie('sid');
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.json({ authed: !!(req.cookies.sid && sessions.has(req.cookies.sid)) });
  });

  // desktop-mode auto-login
  if (autologinToken) {
    app.get('/auth/auto', (req, res) => {
      if (req.query.token !== autologinToken) return res.status(403).send('Forbidden');
      newSession(res);
      res.redirect('/');
    });
  }

  // ================= BOARDS =================

  app.get('/api/boards', requireAuth, (req, res) => {
    const boards = db.prepare('SELECT * FROM boards ORDER BY starred DESC, id DESC').all().map((b) => {
      const counts = db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM lists WHERE board_id = @id AND archived = 0) AS lists,
          (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id
            WHERE l.board_id = @id AND c.archived = 0 AND l.archived = 0) AS cards`
      ).get({ id: b.id });
      return { ...b, list_count: counts.lists, card_count: counts.cards };
    });
    res.json(boards);
  });

  app.post('/api/boards', requireAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Board name is required' });
    const color = String(req.body?.color || '#6366f1');
    const emoji = String(req.body?.emoji || '📋');
    const info = db.prepare('INSERT INTO boards (name, color, emoji) VALUES (?, ?, ?)').run(name, color, emoji);
    logActivity(info.lastInsertRowid, null, 'board_created', `Created board "${name}"`);
    res.json(q.board.get(info.lastInsertRowid));
  });

  app.patch('/api/boards/:id', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : board.name;
    if (!name) return res.status(400).json({ error: 'Board name is required' });
    const color = req.body.color !== undefined ? String(req.body.color) : board.color;
    const emoji = req.body.emoji !== undefined ? String(req.body.emoji) : board.emoji;
    const starred = req.body.starred !== undefined ? (req.body.starred ? 1 : 0) : board.starred;
    db.prepare('UPDATE boards SET name = ?, color = ?, emoji = ?, starred = ? WHERE id = ?')
      .run(name, color, emoji, starred, board.id);
    if (name !== board.name) logActivity(board.id, null, 'board_renamed', `Renamed board to "${name}"`);
    res.json(q.board.get(board.id));
  });

  app.delete('/api/boards/:id', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    // clean up attachment files for the whole board
    const files = db.prepare(
      `SELECT a.filename FROM attachments a JOIN cards c ON c.id = a.card_id
       JOIN lists l ON l.id = c.list_id WHERE l.board_id = ?`
    ).all(board.id);
    db.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    res.json({ ok: true });
  });

  // full board fetch (non-archived lists+cards)
  app.get('/api/boards/:id', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const lists = db.prepare('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY position, id')
      .all(board.id)
      .map((l) => ({
        ...l,
        cards: db.prepare('SELECT * FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id')
          .all(l.id).map(cardSummary)
      }));
    const labels = db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY id').all(board.id);
    res.json({ ...board, lists, labels });
  });

  app.get('/api/boards/:id/activity', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(db.prepare('SELECT * FROM activity WHERE board_id = ? ORDER BY id DESC LIMIT ?').all(board.id, limit));
  });

  // archived items on a board (restorable)
  app.get('/api/boards/:id/archived', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const lists = db.prepare('SELECT * FROM lists WHERE board_id = ? AND archived = 1 ORDER BY position, id').all(board.id);
    const cards = db.prepare(
      `SELECT c.*, l.name AS list_name FROM cards c JOIN lists l ON l.id = c.list_id
       WHERE l.board_id = ? AND c.archived = 1 ORDER BY c.id DESC`
    ).all(board.id);
    res.json({ lists, cards });
  });

  // filter/search cards on a board: ?label=<id>&due=overdue|today|week|none&q=<text>
  app.get('/api/boards/:id/cards', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    let sql = `SELECT c.* FROM cards c JOIN lists l ON l.id = c.list_id
               WHERE l.board_id = ? AND c.archived = 0 AND l.archived = 0`;
    const params = [board.id];
    if (req.query.label) {
      sql += ' AND EXISTS (SELECT 1 FROM card_labels cl WHERE cl.card_id = c.id AND cl.label_id = ?)';
      params.push(Number(req.query.label));
    }
    if (req.query.q) {
      sql += ' AND (c.title LIKE ? OR c.description LIKE ?)';
      const like = `%${req.query.q}%`;
      params.push(like, like);
    }
    const due = req.query.due;
    if (due === 'overdue') sql += " AND c.due_date IS NOT NULL AND c.due_date < datetime('now')";
    else if (due === 'today') sql += " AND c.due_date IS NOT NULL AND date(c.due_date) = date('now')";
    else if (due === 'week') sql += " AND c.due_date IS NOT NULL AND c.due_date >= datetime('now', '-1 day') AND c.due_date <= datetime('now', '+7 day')";
    else if (due === 'none') sql += ' AND c.due_date IS NULL';
    sql += ' ORDER BY l.position, c.position';
    res.json(db.prepare(sql).all(...params).map(cardSummary));
  });

  // ================= LISTS =================

  app.post('/api/boards/:id/lists', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM lists WHERE board_id = ?').get(board.id).p;
    const info = db.prepare('INSERT INTO lists (board_id, name, position) VALUES (?, ?, ?)').run(board.id, name, pos);
    logActivity(board.id, null, 'list_created', `Added list "${name}"`);
    res.json({ ...q.list.get(info.lastInsertRowid), cards: [] });
  });

  app.patch('/api/lists/:id', requireAuth, (req, res) => {
    const list = q.list.get(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : list.name;
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : list.archived;
    db.prepare('UPDATE lists SET name = ?, archived = ? WHERE id = ?').run(name, archived, list.id);
    if (archived !== list.archived) {
      logActivity(list.board_id, null, archived ? 'list_archived' : 'list_restored',
        `${archived ? 'Archived' : 'Restored'} list "${name}"`);
    } else if (name !== list.name) {
      logActivity(list.board_id, null, 'list_renamed', `Renamed list "${list.name}" to "${name}"`);
    }
    res.json(q.list.get(list.id));
  });

  // reorder lists on a board: { order: [listId, ...] }
  app.post('/api/boards/:id/lists/reorder', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!order) return res.status(400).json({ error: 'order array required' });
    const upd = db.prepare('UPDATE lists SET position = ? WHERE id = ? AND board_id = ?');
    const tx = db.transaction(() => order.forEach((id, i) => upd.run(i, id, board.id)));
    tx();
    res.json({ ok: true });
  });

  // ================= CARDS =================

  app.post('/api/lists/:id/cards', requireAuth, (req, res) => {
    const list = q.list.get(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Card title is required' });
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM cards WHERE list_id = ? AND archived = 0').get(list.id).p;
    const info = db.prepare('INSERT INTO cards (list_id, title, description, due_date, position) VALUES (?, ?, ?, ?, ?)')
      .run(list.id, title, String(req.body?.description || ''), req.body?.due_date || null, pos);
    logActivity(list.board_id, info.lastInsertRowid, 'card_created', `Added "${title}" to ${list.name}`);
    res.json(cardSummary(q.card.get(info.lastInsertRowid)));
  });

  app.get('/api/cards/:id', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json(cardDetail(card));
  });

  app.patch('/api/cards/:id', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const boardId = boardIdOfCard(card.id);
    const title = req.body.title !== undefined ? String(req.body.title).trim() : card.title;
    if (!title) return res.status(400).json({ error: 'Card title is required' });
    const description = req.body.description !== undefined ? String(req.body.description) : card.description;
    const due = req.body.due_date !== undefined ? (req.body.due_date || null) : card.due_date;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : card.archived;
    db.prepare('UPDATE cards SET title = ?, description = ?, due_date = ?, archived = ? WHERE id = ?')
      .run(title, description, due, archived, card.id);
    if (archived !== card.archived) {
      logActivity(boardId, card.id, archived ? 'card_archived' : 'card_restored',
        `${archived ? 'Archived' : 'Restored'} "${title}"`);
      renumberList(card.list_id);
    } else {
      if (title !== card.title) logActivity(boardId, card.id, 'card_renamed', `Renamed to "${title}"`);
      if (description !== card.description) logActivity(boardId, card.id, 'card_description', 'Updated the description');
      if (due !== card.due_date) logActivity(boardId, card.id, 'card_due', due ? `Set due date to ${due}` : 'Removed the due date');
    }
    res.json(cardDetail(q.card.get(card.id)));
  });

  app.delete('/api/cards/:id', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const boardId = boardIdOfCard(card.id);
    const files = db.prepare('SELECT filename FROM attachments WHERE card_id = ?').all(card.id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    logActivity(boardId, null, 'card_deleted', `Deleted "${card.title}"`);
    res.json({ ok: true });
  });

  // move card between/within lists: { list_id, position }
  app.post('/api/cards/:id/move', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const toList = q.list.get(Number(req.body?.list_id));
    if (!toList) return res.status(404).json({ error: 'Target list not found' });
    const fromList = q.list.get(card.list_id);
    const index = Math.max(0, Number(req.body?.position) || 0);

    const tx = db.transaction(() => {
      // remaining cards in the target list (excluding the moving card), insert at index
      const targetCards = db.prepare(
        'SELECT id FROM cards WHERE list_id = ? AND archived = 0 AND id != ? ORDER BY position, id'
      ).all(toList.id, card.id).map((c) => c.id);
      targetCards.splice(Math.min(index, targetCards.length), 0, card.id);
      db.prepare('UPDATE cards SET list_id = ? WHERE id = ?').run(toList.id, card.id);
      const upd = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
      targetCards.forEach((id, i) => upd.run(i, id));
      if (fromList.id !== toList.id) renumberList(fromList.id);
    });
    tx();

    if (fromList.id !== toList.id) {
      logActivity(toList.board_id, card.id, 'card_moved', `Moved "${card.title}" from ${fromList.name} to ${toList.name}`);
    }
    res.json(cardSummary(q.card.get(card.id)));
  });

  // ================= LABELS =================

  app.post('/api/boards/:id/labels', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    const color = String(req.body?.color || '#22c55e');
    const info = db.prepare('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)').run(board.id, name, color);
    res.json(q.label.get(info.lastInsertRowid));
  });

  app.patch('/api/labels/:id', requireAuth, (req, res) => {
    const label = q.label.get(req.params.id);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : label.name;
    const color = req.body.color !== undefined ? String(req.body.color) : label.color;
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    db.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ?').run(name, color, label.id);
    res.json(q.label.get(label.id));
  });

  app.delete('/api/labels/:id', requireAuth, (req, res) => {
    const label = q.label.get(req.params.id);
    if (!label) return res.status(404).json({ error: 'Label not found' });
    db.prepare('DELETE FROM labels WHERE id = ?').run(label.id);
    res.json({ ok: true });
  });

  app.post('/api/cards/:id/labels/:labelId', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    const label = q.label.get(req.params.labelId);
    if (!card || !label) return res.status(404).json({ error: 'Not found' });
    db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(card.id, label.id);
    logActivity(label.board_id, card.id, 'label_added', `Added label "${label.name}" to "${card.title}"`);
    res.json({ ok: true, labels: cardLabels(card.id) });
  });

  app.delete('/api/cards/:id/labels/:labelId', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    db.prepare('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?').run(card.id, Number(req.params.labelId));
    res.json({ ok: true, labels: cardLabels(card.id) });
  });

  // ================= CHECKLISTS =================

  app.post('/api/cards/:id/checklists', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const title = String(req.body?.title || 'Checklist').trim() || 'Checklist';
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklists WHERE card_id = ?').get(card.id).p;
    const info = db.prepare('INSERT INTO checklists (card_id, title, position) VALUES (?, ?, ?)').run(card.id, title, pos);
    logActivity(boardIdOfCard(card.id), card.id, 'checklist_added', `Added checklist "${title}"`);
    res.json({ id: info.lastInsertRowid, card_id: card.id, title, position: pos, items: [] });
  });

  app.patch('/api/checklists/:id', requireAuth, (req, res) => {
    const cl = db.prepare('SELECT * FROM checklists WHERE id = ?').get(req.params.id);
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });
    const title = String(req.body?.title || cl.title).trim() || cl.title;
    db.prepare('UPDATE checklists SET title = ? WHERE id = ?').run(title, cl.id);
    res.json({ ok: true });
  });

  app.delete('/api/checklists/:id', requireAuth, (req, res) => {
    const cl = db.prepare('SELECT * FROM checklists WHERE id = ?').get(req.params.id);
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });
    db.prepare('DELETE FROM checklists WHERE id = ?').run(cl.id);
    res.json({ ok: true });
  });

  app.post('/api/checklists/:id/items', requireAuth, (req, res) => {
    const cl = db.prepare('SELECT * FROM checklists WHERE id = ?').get(req.params.id);
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklist_items WHERE checklist_id = ?').get(cl.id).p;
    const info = db.prepare('INSERT INTO checklist_items (checklist_id, text, position) VALUES (?, ?, ?)').run(cl.id, text, pos);
    res.json(db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(info.lastInsertRowid));
  });

  app.patch('/api/checklist-items/:id', requireAuth, (req, res) => {
    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const text = req.body.text !== undefined ? String(req.body.text).trim() : item.text;
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : item.done;
    db.prepare('UPDATE checklist_items SET text = ?, done = ? WHERE id = ?').run(text, done, item.id);
    if (done !== item.done && done) {
      const cl = db.prepare('SELECT * FROM checklists WHERE id = ?').get(item.checklist_id);
      logActivity(boardIdOfCard(cl.card_id), cl.card_id, 'item_completed', `Completed "${text}"`);
    }
    const cl = db.prepare('SELECT * FROM checklists WHERE id = ?').get(item.checklist_id);
    res.json({ ...db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(item.id), progress: checklistProgress(cl.card_id) });
  });

  app.delete('/api/checklist-items/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM checklist_items WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ================= COMMENTS =================

  app.post('/api/cards/:id/comments', requireAuth, (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment body is required' });
    const author = String(req.body?.author || 'Admin').trim() || 'Admin';
    const info = db.prepare('INSERT INTO comments (card_id, author, body) VALUES (?, ?, ?)').run(card.id, author, body);
    logActivity(boardIdOfCard(card.id), card.id, 'comment_added', `Commented on "${card.title}"`);
    res.json(db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid));
  });

  app.delete('/api/comments/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ================= ATTACHMENTS =================

  app.post('/api/cards/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
    const card = q.card.get(req.params.id);
    if (!card) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Card not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const info = db.prepare(
      'INSERT INTO attachments (card_id, filename, original_name, size, mime) VALUES (?, ?, ?, ?, ?)'
    ).run(card.id, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype);
    logActivity(boardIdOfCard(card.id), card.id, 'attachment_added', `Attached ${req.file.originalname}`);
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid);
    res.json({ ...row, url: `/uploads/${row.filename}` });
  });

  app.delete('/api/attachments/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    try { fs.unlinkSync(path.join(uploadsDir, row.filename)); } catch {}
    res.json({ ok: true });
  });

  // ================= EXPORT / IMPORT =================

  app.get('/api/boards/:id/export', requireAuth, (req, res) => {
    const board = q.board.get(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const labels = db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY id').all(board.id);
    const lists = db.prepare('SELECT * FROM lists WHERE board_id = ? ORDER BY position, id').all(board.id).map((l) => ({
      name: l.name,
      position: l.position,
      archived: l.archived,
      cards: db.prepare('SELECT * FROM cards WHERE list_id = ? ORDER BY position, id').all(l.id).map((c) => ({
        title: c.title,
        description: c.description,
        position: c.position,
        due_date: c.due_date,
        archived: c.archived,
        created_at: c.created_at,
        labels: cardLabels(c.id).map((lb) => lb.name),
        checklists: db.prepare('SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id').all(c.id).map((cl) => ({
          title: cl.title,
          items: db.prepare('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position, id')
            .all(cl.id).map((i) => ({ text: i.text, done: i.done }))
        })),
        comments: db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY id').all(c.id)
          .map((cm) => ({ author: cm.author, body: cm.body, created_at: cm.created_at })),
        attachments: db.prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY id').all(c.id).map((a) => {
          let data = null;
          try { data = fs.readFileSync(path.join(uploadsDir, a.filename)).toString('base64'); } catch {}
          return { original_name: a.original_name, mime: a.mime, size: a.size, data };
        })
      }))
    }));
    const payload = {
      app: 'boardly',
      version: 1,
      exported_at: new Date().toISOString(),
      board: { name: board.name, color: board.color, emoji: board.emoji, starred: board.starred },
      labels: labels.map((lb) => ({ name: lb.name, color: lb.color })),
      lists
    };
    res.setHeader('Content-Disposition', `attachment; filename="${board.name.replace(/[^\w\- ]+/g, '')}-boardly-export.json"`);
    res.json(payload);
  });

  app.post('/api/boards/import', requireAuth, (req, res) => {
    const data = req.body;
    if (!data || data.app !== 'boardly' || !data.board || !Array.isArray(data.lists)) {
      return res.status(400).json({ error: 'Not a valid Boardly export file' });
    }
    let boardId;
    const pendingFiles = []; // written after the transaction commits
    const tx = db.transaction(() => {
      const b = data.board;
      boardId = db.prepare('INSERT INTO boards (name, color, emoji, starred) VALUES (?, ?, ?, ?)')
        .run(String(b.name || 'Imported board'), String(b.color || '#6366f1'), String(b.emoji || '📋'), b.starred ? 1 : 0)
        .lastInsertRowid;
      const labelIds = {};
      for (const lb of data.labels || []) {
        labelIds[lb.name] = db.prepare('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)')
          .run(boardId, String(lb.name), String(lb.color || '#22c55e')).lastInsertRowid;
      }
      for (const l of data.lists) {
        const listId = db.prepare('INSERT INTO lists (board_id, name, position, archived) VALUES (?, ?, ?, ?)')
          .run(boardId, String(l.name), Number(l.position) || 0, l.archived ? 1 : 0).lastInsertRowid;
        for (const c of l.cards || []) {
          const cardId = db.prepare(
            'INSERT INTO cards (list_id, title, description, position, due_date, archived) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(listId, String(c.title), String(c.description || ''), Number(c.position) || 0,
                c.due_date || null, c.archived ? 1 : 0).lastInsertRowid;
          for (const name of c.labels || []) {
            if (labelIds[name]) {
              db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(cardId, labelIds[name]);
            }
          }
          (c.checklists || []).forEach((cl, cli) => {
            const clId = db.prepare('INSERT INTO checklists (card_id, title, position) VALUES (?, ?, ?)')
              .run(cardId, String(cl.title || 'Checklist'), cli).lastInsertRowid;
            (cl.items || []).forEach((it, ii) => {
              db.prepare('INSERT INTO checklist_items (checklist_id, text, done, position) VALUES (?, ?, ?, ?)')
                .run(clId, String(it.text), it.done ? 1 : 0, ii);
            });
          });
          for (const cm of c.comments || []) {
            db.prepare('INSERT INTO comments (card_id, author, body, created_at) VALUES (?, ?, ?, ?)')
              .run(cardId, String(cm.author || 'Admin'), String(cm.body), cm.created_at || new Date().toISOString());
          }
          for (const a of c.attachments || []) {
            if (!a || !a.data) continue;
            const ext = (path.extname(a.original_name || '') || '').toLowerCase().slice(0, 12);
            const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
            const buf = Buffer.from(a.data, 'base64');
            db.prepare('INSERT INTO attachments (card_id, filename, original_name, size, mime) VALUES (?, ?, ?, ?, ?)')
              .run(cardId, filename, String(a.original_name || filename), buf.length, String(a.mime || 'application/octet-stream'));
            pendingFiles.push({ filename, buf });
          }
        }
      }
      db.prepare('INSERT INTO activity (board_id, card_id, action, detail) VALUES (?, NULL, ?, ?)')
        .run(boardId, 'board_imported', `Imported board "${b.name}"`);
    });
    tx();
    for (const f of pendingFiles) fs.writeFileSync(path.join(uploadsDir, f.filename), f.buf);
    res.json(q.board.get(boardId));
  });

  // ================= FRONTEND =================

  const distDir = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api|uploads|auth).*/, (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

module.exports = { createApp };
