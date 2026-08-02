// Boardly MCP tools — shared by both transports:
//   mcp/server.js  (stdio, spawned by an external AI client)
//   mcp/http.js    (streamable HTTP, started from inside the running Boardly app)
//
// Every write mirrors server/app.js (activity log, positions, cascades) so the
// Boardly UI stays consistent whichever path made the change.

const path = require('path');
const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');

// Data dir resolution (stdio entry only — the in-app transport passes its own db):
//   1. BOARDLY_DATA_DIR env var
//   2. %APPDATA%\boardly\data (desktop app default) if it exists
//   3. ../data (web server default)
function resolveDataDir() {
  if (process.env.BOARDLY_DATA_DIR) return process.env.BOARDLY_DATA_DIR;
  const appData = process.env.APPDATA;
  if (appData) {
    const desktopDir = path.join(appData, 'boardly', 'data');
    if (fs.existsSync(desktopDir)) return desktopDir;
  }
  return path.join(__dirname, '..', 'data');
}

function createBoardlyServer({ db, uploadsDir }) {
  const server = new McpServer({ name: 'boardly', version: '1.1.0' });

  // ---- helpers (mirrors server/app.js) ----

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
    return {
      ...card,
      labels: cardLabels(card.id),
      checklist: checklistProgress(card.id),
      has_description: card.description.trim().length > 0
    };
  }

  function renumberList(listId) {
    const cards = db.prepare('SELECT id FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id').all(listId);
    const upd = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    cards.forEach((c, i) => upd.run(i, c.id));
  }

  function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  function fail(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  function tool(name, description, schema, handler) {
    server.registerTool(name, { description, inputSchema: schema }, async (args) => {
      try {
        return ok(handler(args));
      } catch (err) {
        return fail(err.message || String(err));
      }
    });
  }

  function mustGet(stmt, id, what) {
    const row = stmt.get(id);
    if (!row) throw new Error(`${what} not found`);
    return row;
  }

  // ---- boards ----

  tool('list_boards', 'List all boards with list/card counts', {}, () => {
    return db.prepare('SELECT * FROM boards ORDER BY starred DESC, id DESC').all().map((b) => {
      const counts = db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM lists WHERE board_id = @id AND archived = 0) AS lists,
          (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id
            WHERE l.board_id = @id AND c.archived = 0 AND l.archived = 0) AS cards`
      ).get({ id: b.id });
      return { ...b, list_count: counts.lists, card_count: counts.cards };
    });
  });

  tool('get_board', 'Get a board with its (non-archived) lists, cards and labels', {
    board_id: z.number().int().describe('Board ID')
  }, ({ board_id }) => {
    const board = mustGet(q.board, board_id, 'Board');
    const lists = db.prepare('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY position, id')
      .all(board.id)
      .map((l) => ({
        ...l,
        cards: db.prepare('SELECT * FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id')
          .all(l.id).map(cardSummary)
      }));
    const labels = db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY id').all(board.id);
    return { ...board, lists, labels };
  });

  tool('create_board', 'Create a new board', {
    name: z.string().min(1).describe('Board name'),
    description: z.string().optional().describe('Project description — what this board is for'),
    color: z.string().optional().describe('Hex color, e.g. #6366f1'),
    emoji: z.string().optional().describe('Board emoji, e.g. 📋')
  }, ({ name, description, color, emoji }) => {
    const info = db.prepare('INSERT INTO boards (name, description, color, emoji) VALUES (?, ?, ?, ?)')
      .run(name.trim(), description || '', color || '#6366f1', emoji || '📋');
    logActivity(info.lastInsertRowid, null, 'board_created', `Created board "${name.trim()}"`);
    return q.board.get(info.lastInsertRowid);
  });

  tool('update_board', 'Update a board (rename, set the project description, recolor, star/unstar)', {
    board_id: z.number().int(),
    name: z.string().min(1).optional(),
    description: z.string().optional().describe('Project description — what this board is for'),
    color: z.string().optional(),
    emoji: z.string().optional(),
    starred: z.boolean().optional()
  }, ({ board_id, name, description, color, emoji, starred }) => {
    const board = mustGet(q.board, board_id, 'Board');
    const newName = name !== undefined ? name.trim() : board.name;
    if (!newName) throw new Error('Board name is required');
    const newDesc = description !== undefined ? description : board.description;
    db.prepare('UPDATE boards SET name = ?, description = ?, color = ?, emoji = ?, starred = ? WHERE id = ?')
      .run(newName,
        newDesc,
        color !== undefined ? color : board.color,
        emoji !== undefined ? emoji : board.emoji,
        starred !== undefined ? (starred ? 1 : 0) : board.starred,
        board.id);
    if (newName !== board.name) logActivity(board.id, null, 'board_renamed', `Renamed board to "${newName}"`);
    if (newDesc !== board.description) logActivity(board.id, null, 'board_description', 'Updated the project description');
    return q.board.get(board.id);
  });

  tool('delete_board', 'Delete a board and everything on it (lists, cards, attachments)', {
    board_id: z.number().int()
  }, ({ board_id }) => {
    const board = mustGet(q.board, board_id, 'Board');
    const files = db.prepare(
      `SELECT a.filename FROM attachments a JOIN cards c ON c.id = a.card_id
       JOIN lists l ON l.id = c.list_id WHERE l.board_id = ?`
    ).all(board.id);
    db.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    return { ok: true, deleted_board: board.name };
  });

  // ---- lists ----

  tool('create_list', 'Add a list (column) to a board', {
    board_id: z.number().int(),
    name: z.string().min(1).describe('List name')
  }, ({ board_id, name }) => {
    const board = mustGet(q.board, board_id, 'Board');
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM lists WHERE board_id = ?').get(board.id).p;
    const info = db.prepare('INSERT INTO lists (board_id, name, position) VALUES (?, ?, ?)').run(board.id, name.trim(), pos);
    logActivity(board.id, null, 'list_created', `Added list "${name.trim()}"`);
    return { ...q.list.get(info.lastInsertRowid), cards: [] };
  });

  tool('update_list', 'Rename or archive/restore a list', {
    list_id: z.number().int(),
    name: z.string().min(1).optional(),
    archived: z.boolean().optional()
  }, ({ list_id, name, archived }) => {
    const list = mustGet(q.list, list_id, 'List');
    const newName = name !== undefined ? name.trim() : list.name;
    if (!newName) throw new Error('List name is required');
    const newArchived = archived !== undefined ? (archived ? 1 : 0) : list.archived;
    db.prepare('UPDATE lists SET name = ?, archived = ? WHERE id = ?').run(newName, newArchived, list.id);
    if (newArchived !== list.archived) {
      logActivity(list.board_id, null, newArchived ? 'list_archived' : 'list_restored',
        `${newArchived ? 'Archived' : 'Restored'} list "${newName}"`);
    } else if (newName !== list.name) {
      logActivity(list.board_id, null, 'list_renamed', `Renamed list "${list.name}" to "${newName}"`);
    }
    return q.list.get(list.id);
  });

  // ---- cards ----

  tool('create_card', 'Add a card to a list', {
    list_id: z.number().int(),
    title: z.string().min(1),
    description: z.string().optional(),
    due_date: z.string().optional().describe('ISO date/datetime, e.g. 2026-08-15')
  }, ({ list_id, title, description, due_date }) => {
    const list = mustGet(q.list, list_id, 'List');
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM cards WHERE list_id = ? AND archived = 0').get(list.id).p;
    const info = db.prepare('INSERT INTO cards (list_id, title, description, due_date, position) VALUES (?, ?, ?, ?, ?)')
      .run(list.id, title.trim(), description || '', due_date || null, pos);
    logActivity(list.board_id, info.lastInsertRowid, 'card_created', `Added "${title.trim()}" to ${list.name}`);
    return cardSummary(q.card.get(info.lastInsertRowid));
  });

  tool('update_card', 'Update a card (title, description, due date, archive/restore)', {
    card_id: z.number().int(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    due_date: z.string().nullable().optional().describe('ISO date, or null to clear'),
    archived: z.boolean().optional()
  }, ({ card_id, title, description, due_date, archived }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const boardId = boardIdOfCard(card.id);
    const newTitle = title !== undefined ? title.trim() : card.title;
    if (!newTitle) throw new Error('Card title is required');
    const newDesc = description !== undefined ? description : card.description;
    const newDue = due_date !== undefined ? (due_date || null) : card.due_date;
    const newArchived = archived !== undefined ? (archived ? 1 : 0) : card.archived;
    db.prepare('UPDATE cards SET title = ?, description = ?, due_date = ?, archived = ? WHERE id = ?')
      .run(newTitle, newDesc, newDue, newArchived, card.id);
    if (newArchived !== card.archived) {
      logActivity(boardId, card.id, newArchived ? 'card_archived' : 'card_restored',
        `${newArchived ? 'Archived' : 'Restored'} "${newTitle}"`);
      renumberList(card.list_id);
    } else {
      if (newTitle !== card.title) logActivity(boardId, card.id, 'card_renamed', `Renamed to "${newTitle}"`);
      if (newDesc !== card.description) logActivity(boardId, card.id, 'card_description', 'Updated the description');
      if (newDue !== card.due_date) logActivity(boardId, card.id, 'card_due', newDue ? `Set due date to ${newDue}` : 'Removed the due date');
    }
    return cardSummary(q.card.get(card.id));
  });

  tool('move_card', 'Move a card to another list (or reorder within its list)', {
    card_id: z.number().int(),
    list_id: z.number().int().describe('Target list ID'),
    position: z.number().int().min(0).optional().describe('Index in the target list (default 0)')
  }, ({ card_id, list_id, position }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const toList = mustGet(q.list, list_id, 'Target list');
    const fromList = mustGet(q.list, card.list_id, 'Source list');
    const index = Math.max(0, position || 0);

    const tx = db.transaction(() => {
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
    return cardSummary(q.card.get(card.id));
  });

  tool('delete_card', 'Delete a card (and its attachments, checklists, comments)', {
    card_id: z.number().int()
  }, ({ card_id }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const boardId = boardIdOfCard(card.id);
    const files = db.prepare('SELECT filename FROM attachments WHERE card_id = ?').all(card.id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    logActivity(boardId, null, 'card_deleted', `Deleted "${card.title}"`);
    return { ok: true, deleted_card: card.title };
  });

  // ---- labels ----

  tool('create_label', 'Create a label on a board', {
    board_id: z.number().int(),
    name: z.string().min(1),
    color: z.string().optional().describe('Hex color, e.g. #22c55e')
  }, ({ board_id, name, color }) => {
    const board = mustGet(q.board, board_id, 'Board');
    const info = db.prepare('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)')
      .run(board.id, name.trim(), color || '#22c55e');
    return q.label.get(info.lastInsertRowid);
  });

  tool('assign_label', 'Attach a label to a card', {
    card_id: z.number().int(),
    label_id: z.number().int()
  }, ({ card_id, label_id }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const label = mustGet(q.label, label_id, 'Label');
    db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(card.id, label.id);
    logActivity(label.board_id, card.id, 'label_added', `Added label "${label.name}" to "${card.title}"`);
    return { ok: true, labels: cardLabels(card.id) };
  });

  tool('unassign_label', 'Remove a label from a card', {
    card_id: z.number().int(),
    label_id: z.number().int()
  }, ({ card_id, label_id }) => {
    const card = mustGet(q.card, card_id, 'Card');
    db.prepare('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?').run(card.id, label_id);
    return { ok: true, labels: cardLabels(card.id) };
  });

  // ---- checklists ----

  tool('add_checklist', 'Add a checklist to a card', {
    card_id: z.number().int(),
    title: z.string().optional().describe('Checklist title (default "Checklist")')
  }, ({ card_id, title }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const clTitle = (title || 'Checklist').trim() || 'Checklist';
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklists WHERE card_id = ?').get(card.id).p;
    const info = db.prepare('INSERT INTO checklists (card_id, title, position) VALUES (?, ?, ?)').run(card.id, clTitle, pos);
    logActivity(boardIdOfCard(card.id), card.id, 'checklist_added', `Added checklist "${clTitle}"`);
    return { id: info.lastInsertRowid, card_id: card.id, title: clTitle, position: pos, items: [] };
  });

  tool('add_checklist_item', 'Add an item to a checklist', {
    checklist_id: z.number().int(),
    text: z.string().min(1)
  }, ({ checklist_id, text }) => {
    const cl = mustGet(db.prepare('SELECT * FROM checklists WHERE id = ?'), checklist_id, 'Checklist');
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklist_items WHERE checklist_id = ?').get(cl.id).p;
    const info = db.prepare('INSERT INTO checklist_items (checklist_id, text, position) VALUES (?, ?, ?)')
      .run(cl.id, text.trim(), pos);
    return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(info.lastInsertRowid);
  });

  tool('set_checklist_item', 'Update a checklist item (edit text, mark done/undone)', {
    item_id: z.number().int(),
    text: z.string().min(1).optional(),
    done: z.boolean().optional()
  }, ({ item_id, text, done }) => {
    const item = mustGet(db.prepare('SELECT * FROM checklist_items WHERE id = ?'), item_id, 'Checklist item');
    const newText = text !== undefined ? text.trim() : item.text;
    if (!newText) throw new Error('Item text is required');
    const newDone = done !== undefined ? (done ? 1 : 0) : item.done;
    db.prepare('UPDATE checklist_items SET text = ?, done = ? WHERE id = ?').run(newText, newDone, item.id);
    const cl = db.prepare('SELECT * FROM checklists WHERE id = ?').get(item.checklist_id);
    if (newDone !== item.done && newDone) {
      logActivity(boardIdOfCard(cl.card_id), cl.card_id, 'item_completed', `Completed "${newText}"`);
    }
    return { ...db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(item.id), progress: checklistProgress(cl.card_id) };
  });

  // ---- attachments ----

  tool('attach_link', 'Attach a link to a card — a local file path or a URL. Stored as a small .url shortcut, so attaching a 200MB installer costs a couple of hundred bytes.', {
    card_id: z.number().int(),
    target: z.string().min(1).describe('A URL (https://…) or an absolute local path (C:\\… or /…)'),
    name: z.string().optional().describe('Display name (defaults to the file/link name)')
  }, ({ card_id, target, name }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
    // A .url shortcut works for both: Windows resolves file: URLs the same way.
    const href = isUrl ? target : 'file:///' + target.replace(/\\/g, '/').replace(/^\/+/, '');
    const display = (name || '').trim() ||
      (isUrl ? target.replace(/\/+$/, '').split('/').pop() || target
             : target.split(/[\\/]/).pop());
    const safe = display.replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}.url`;
    const body = `[InternetShortcut]\r\nURL=${href}\r\n`;
    fs.writeFileSync(path.join(uploadsDir, filename), body);
    const info = db.prepare(
      'INSERT INTO attachments (card_id, filename, original_name, size, mime) VALUES (?, ?, ?, ?, ?)'
    ).run(card.id, filename, `${safe}.url`, Buffer.byteLength(body), 'application/internet-shortcut');
    logActivity(boardIdOfCard(card.id), card.id, 'attachment_added', `Attached ${safe}`);
    return { ...db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid), target: href };
  });

  tool('list_attachments', 'List a card\'s attachments', {
    card_id: z.number().int()
  }, ({ card_id }) => {
    const card = mustGet(q.card, card_id, 'Card');
    return db.prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY id').all(card.id)
      .map((a) => ({ ...a, url: `/uploads/${a.filename}` }));
  });

  tool('delete_attachment', 'Remove an attachment from a card', {
    attachment_id: z.number().int()
  }, ({ attachment_id }) => {
    const row = mustGet(db.prepare('SELECT * FROM attachments WHERE id = ?'), attachment_id, 'Attachment');
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    try { fs.unlinkSync(path.join(uploadsDir, row.filename)); } catch {}
    return { ok: true, deleted: row.original_name };
  });

  // ---- comments ----

  tool('add_comment', 'Add a comment to a card', {
    card_id: z.number().int(),
    body: z.string().min(1),
    author: z.string().optional().describe('Comment author (default "Admin")')
  }, ({ card_id, body, author }) => {
    const card = mustGet(q.card, card_id, 'Card');
    const name = (author || 'Admin').trim() || 'Admin';
    const info = db.prepare('INSERT INTO comments (card_id, author, body) VALUES (?, ?, ?)')
      .run(card.id, name, body.trim());
    logActivity(boardIdOfCard(card.id), card.id, 'comment_added', `Commented on "${card.title}"`);
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  });

  return server;
}

module.exports = { createBoardlyServer, resolveDataDir };
