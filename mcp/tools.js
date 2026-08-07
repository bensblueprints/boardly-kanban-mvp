// Boardly MCP tools — shared by both transports:
//   mcp/server.js  (stdio, spawned by an external AI client)
//   mcp/http.js    (streamable HTTP, started from inside the running Boardly app)
//
// Every write mirrors server/app.js (activity log, positions, cascades) so the
// Boardly UI stays consistent whichever path made the change.
//
// `db` is the async store from server/data (one interface over SQLite and
// Postgres), so every handler below is async.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
    board: 'SELECT * FROM boards WHERE id = ?',
    list: 'SELECT * FROM lists WHERE id = ?',
    card: 'SELECT * FROM cards WHERE id = ?',
    label: 'SELECT * FROM labels WHERE id = ?'
  };

  async function logActivity(boardId, cardId, action, detail = '') {
    await db.run('INSERT INTO activity (board_id, card_id, action, detail) VALUES (?, ?, ?, ?)',
      [boardId, cardId, action, detail]);
  }

  // Sync bookkeeping, mirroring server/app.js: new rows get a UUID, an
  // updated_at stamp, and a rev from the store-wide counter. Boards also get
  // an owner — the implicit local user on the desktop; cloud MCP (a later
  // task) will pass the token's user instead.
  const ownerId = db.localUser ? db.localUser.id : 0;

  async function nextRev(s = db) {
    return (await s.one("UPDATE sync_state SET v = v + 1 WHERE k = 'rev' RETURNING v")).v;
  }

  async function boardIdOfCard(cardId) {
    const row = await db.one(
      'SELECT l.board_id AS bid FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.id = ?',
      [cardId]
    );
    return row ? row.bid : null;
  }

  async function cardLabels(cardId) {
    return db.all(
      `SELECT lb.* FROM labels lb JOIN card_labels cl ON cl.label_id = lb.id
       WHERE cl.card_id = ? ORDER BY lb.id`,
      [cardId]
    );
  }

  async function checklistProgress(cardId) {
    const row = await db.one(
      `SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done
       FROM checklist_items ci JOIN checklists c ON c.id = ci.checklist_id
       WHERE c.card_id = ?`,
      [cardId]
    );
    return { total: row.total, done: row.done };
  }

  async function cardSummary(card) {
    return {
      ...card,
      labels: await cardLabels(card.id),
      checklist: await checklistProgress(card.id),
      has_description: card.description.trim().length > 0
    };
  }

  // `s` lets a transaction pass its scoped store; plain calls use the pool.
  async function renumberList(listId, s = db) {
    const cards = await s.all('SELECT id FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id', [listId]);
    for (let i = 0; i < cards.length; i++) {
      await s.run('UPDATE cards SET position = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
        [i, await nextRev(s), cards[i].id]);
    }
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
        return ok(await handler(args));
      } catch (err) {
        return fail(err.message || String(err));
      }
    });
  }

  async function mustGet(sql, id, what) {
    const row = await db.one(sql, [id]);
    if (!row) throw new Error(`${what} not found`);
    return row;
  }

  // ---- boards ----

  tool('list_boards', 'List all boards with list/card counts', {}, async () => {
    const boards = [];
    for (const b of await db.all('SELECT * FROM boards ORDER BY starred DESC, id DESC')) {
      const counts = await db.one(
        `SELECT
          (SELECT COUNT(*) FROM lists WHERE board_id = ? AND archived = 0) AS lists,
          (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id
            WHERE l.board_id = ? AND c.archived = 0 AND l.archived = 0) AS cards`,
        [b.id, b.id]
      );
      boards.push({ ...b, list_count: counts.lists, card_count: counts.cards });
    }
    return boards;
  });

  tool('get_board', 'Get a board with its (non-archived) lists, cards and labels', {
    board_id: z.number().int().describe('Board ID')
  }, async ({ board_id }) => {
    const board = await mustGet(q.board, board_id, 'Board');
    const lists = [];
    for (const l of await db.all('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY position, id', [board.id])) {
      const cards = [];
      for (const c of await db.all('SELECT * FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id', [l.id])) {
        cards.push(await cardSummary(c));
      }
      lists.push({ ...l, cards });
    }
    const labels = await db.all('SELECT * FROM labels WHERE board_id = ? ORDER BY id', [board.id]);
    return { ...board, lists, labels };
  });

  tool('create_board', 'Create a new board', {
    name: z.string().min(1).describe('Board name'),
    description: z.string().optional().describe('Project description — what this board is for'),
    color: z.string().optional().describe('Hex color, e.g. #6366f1'),
    emoji: z.string().optional().describe('Board emoji, e.g. 📋')
  }, async ({ name, description, color, emoji }) => {
    const board = await db.one(
      `INSERT INTO boards (name, description, color, emoji, owner_id, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [name.trim(), description || '', color || '#6366f1', emoji || '📋',
       ownerId, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(board.id, null, 'board_created', `Created board "${name.trim()}"`);
    return board;
  });

  tool('update_board', 'Update a board (rename, set the project description, recolor, star/unstar)', {
    board_id: z.number().int(),
    name: z.string().min(1).optional(),
    description: z.string().optional().describe('Project description — what this board is for'),
    color: z.string().optional(),
    emoji: z.string().optional(),
    starred: z.boolean().optional()
  }, async ({ board_id, name, description, color, emoji, starred }) => {
    const board = await mustGet(q.board, board_id, 'Board');
    const newName = name !== undefined ? name.trim() : board.name;
    if (!newName) throw new Error('Board name is required');
    const newDesc = description !== undefined ? description : board.description;
    await db.run('UPDATE boards SET name = ?, description = ?, color = ?, emoji = ?, starred = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [newName,
        newDesc,
        color !== undefined ? color : board.color,
        emoji !== undefined ? emoji : board.emoji,
        starred !== undefined ? (starred ? 1 : 0) : board.starred,
        await nextRev(),
        board.id]);
    if (newName !== board.name) await logActivity(board.id, null, 'board_renamed', `Renamed board to "${newName}"`);
    if (newDesc !== board.description) await logActivity(board.id, null, 'board_description', 'Updated the project description');
    return db.one(q.board, [board.id]);
  });

  tool('delete_board', 'Delete a board and everything on it (lists, cards, attachments)', {
    board_id: z.number().int()
  }, async ({ board_id }) => {
    const board = await mustGet(q.board, board_id, 'Board');
    const files = await db.all(
      `SELECT a.filename FROM attachments a JOIN cards c ON c.id = a.card_id
       JOIN lists l ON l.id = c.list_id WHERE l.board_id = ?`,
      [board.id]
    );
    await db.run('DELETE FROM boards WHERE id = ?', [board.id]);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    return { ok: true, deleted_board: board.name };
  });

  // ---- lists ----

  tool('create_list', 'Add a list (column) to a board', {
    board_id: z.number().int(),
    name: z.string().min(1).describe('List name')
  }, async ({ board_id, name }) => {
    const board = await mustGet(q.board, board_id, 'Board');
    const pos = (await db.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM lists WHERE board_id = ?', [board.id])).p;
    const list = await db.one(
      `INSERT INTO lists (board_id, name, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [board.id, name.trim(), pos, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(board.id, null, 'list_created', `Added list "${name.trim()}"`);
    return { ...list, cards: [] };
  });

  tool('update_list', 'Rename or archive/restore a list', {
    list_id: z.number().int(),
    name: z.string().min(1).optional(),
    archived: z.boolean().optional()
  }, async ({ list_id, name, archived }) => {
    const list = await mustGet(q.list, list_id, 'List');
    const newName = name !== undefined ? name.trim() : list.name;
    if (!newName) throw new Error('List name is required');
    const newArchived = archived !== undefined ? (archived ? 1 : 0) : list.archived;
    await db.run('UPDATE lists SET name = ?, archived = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [newName, newArchived, await nextRev(), list.id]);
    if (newArchived !== list.archived) {
      await logActivity(list.board_id, null, newArchived ? 'list_archived' : 'list_restored',
        `${newArchived ? 'Archived' : 'Restored'} list "${newName}"`);
    } else if (newName !== list.name) {
      await logActivity(list.board_id, null, 'list_renamed', `Renamed list "${list.name}" to "${newName}"`);
    }
    return db.one(q.list, [list.id]);
  });

  // ---- cards ----

  tool('get_card', 'Get one card in full — description, labels, checklists with every item and its id, comments, attachments and recent activity', {
    card_id: z.number().int()
  }, async ({ card_id }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const checklists = [];
    for (const cl of await db.all('SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id', [card.id])) {
      checklists.push({
        ...cl,
        items: await db.all('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position, id', [cl.id])
      });
    }
    return {
      ...card,
      board_id: await boardIdOfCard(card.id),
      labels: await cardLabels(card.id),
      checklists,
      comments: await db.all('SELECT * FROM comments WHERE card_id = ? ORDER BY id DESC', [card.id]),
      attachments: (await db.all('SELECT * FROM attachments WHERE card_id = ? ORDER BY id DESC', [card.id]))
        .map((a) => ({ ...a, url: `/uploads/${a.filename}` })),
      activity: await db.all('SELECT * FROM activity WHERE card_id = ? ORDER BY id DESC LIMIT 50', [card.id])
    };
  });

  tool('find_cards', 'Search cards across all boards by title (substring, case-insensitive)', {
    query: z.string().min(1),
    board_id: z.number().int().optional().describe('Restrict to one board'),
    limit: z.number().int().min(1).max(200).optional()
  }, async ({ query, board_id, limit }) => {
    const rows = board_id === undefined
      ? await db.all(
          `SELECT c.*, l.name AS list_name, l.board_id, b.name AS board_name
           FROM cards c
           JOIN lists l ON l.id = c.list_id
           JOIN boards b ON b.id = l.board_id
           WHERE c.archived = 0 AND c.title {{ilike}} ?
           ORDER BY c.id LIMIT ?`,
          [`%${query}%`, limit || 50]
        )
      : await db.all(
          `SELECT c.*, l.name AS list_name, l.board_id, b.name AS board_name
           FROM cards c
           JOIN lists l ON l.id = c.list_id
           JOIN boards b ON b.id = l.board_id
           WHERE c.archived = 0 AND c.title {{ilike}} ? AND l.board_id = ?
           ORDER BY c.id LIMIT ?`,
          [`%${query}%`, board_id, limit || 50]
        );
    const out = [];
    for (const r of rows) out.push({ ...r, checklist: await checklistProgress(r.id) });
    return out;
  });

  tool('create_card', 'Add a card to a list', {
    list_id: z.number().int(),
    title: z.string().min(1),
    description: z.string().optional(),
    due_date: z.string().optional().describe('ISO date/datetime, e.g. 2026-08-15')
  }, async ({ list_id, title, description, due_date }) => {
    const list = await mustGet(q.list, list_id, 'List');
    const pos = (await db.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM cards WHERE list_id = ? AND archived = 0', [list.id])).p;
    const card = await db.one(
      `INSERT INTO cards (list_id, title, description, due_date, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [list.id, title.trim(), description || '', due_date || null, pos,
       crypto.randomUUID(), await nextRev()]
    );
    await logActivity(list.board_id, card.id, 'card_created', `Added "${title.trim()}" to ${list.name}`);
    return cardSummary(card);
  });

  tool('update_card', 'Update a card (title, description, due date, archive/restore)', {
    card_id: z.number().int(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    due_date: z.string().nullable().optional().describe('ISO date, or null to clear'),
    archived: z.boolean().optional()
  }, async ({ card_id, title, description, due_date, archived }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const boardId = await boardIdOfCard(card.id);
    const newTitle = title !== undefined ? title.trim() : card.title;
    if (!newTitle) throw new Error('Card title is required');
    const newDesc = description !== undefined ? description : card.description;
    const newDue = due_date !== undefined ? (due_date || null) : card.due_date;
    const newArchived = archived !== undefined ? (archived ? 1 : 0) : card.archived;
    await db.run('UPDATE cards SET title = ?, description = ?, due_date = ?, archived = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [newTitle, newDesc, newDue, newArchived, await nextRev(), card.id]);
    if (newArchived !== card.archived) {
      await logActivity(boardId, card.id, newArchived ? 'card_archived' : 'card_restored',
        `${newArchived ? 'Archived' : 'Restored'} "${newTitle}"`);
      await renumberList(card.list_id);
    } else {
      if (newTitle !== card.title) await logActivity(boardId, card.id, 'card_renamed', `Renamed to "${newTitle}"`);
      if (newDesc !== card.description) await logActivity(boardId, card.id, 'card_description', 'Updated the description');
      if (newDue !== card.due_date) await logActivity(boardId, card.id, 'card_due', newDue ? `Set due date to ${newDue}` : 'Removed the due date');
    }
    return cardSummary(await db.one(q.card, [card.id]));
  });

  tool('move_card', 'Move a card to another list (or reorder within its list)', {
    card_id: z.number().int(),
    list_id: z.number().int().describe('Target list ID'),
    position: z.number().int().min(0).optional().describe('Index in the target list (default 0)')
  }, async ({ card_id, list_id, position }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const toList = await mustGet(q.list, list_id, 'Target list');
    const fromList = await mustGet(q.list, card.list_id, 'Source list');
    const index = Math.max(0, position || 0);

    await db.tx(async (t) => {
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
    return cardSummary(await db.one(q.card, [card.id]));
  });

  tool('delete_card', 'Delete a card (and its attachments, checklists, comments)', {
    card_id: z.number().int()
  }, async ({ card_id }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const boardId = await boardIdOfCard(card.id);
    const files = await db.all('SELECT filename FROM attachments WHERE card_id = ?', [card.id]);
    await db.run('DELETE FROM cards WHERE id = ?', [card.id]);
    for (const f of files) {
      try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch {}
    }
    await logActivity(boardId, null, 'card_deleted', `Deleted "${card.title}"`);
    return { ok: true, deleted_card: card.title };
  });

  // ---- labels ----

  tool('create_label', 'Create a label on a board', {
    board_id: z.number().int(),
    name: z.string().min(1),
    color: z.string().optional().describe('Hex color, e.g. #22c55e')
  }, async ({ board_id, name, color }) => {
    const board = await mustGet(q.board, board_id, 'Board');
    return db.one(
      `INSERT INTO labels (board_id, name, color, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [board.id, name.trim(), color || '#22c55e', crypto.randomUUID(), await nextRev()]
    );
  });

  tool('assign_label', 'Attach a label to a card', {
    card_id: z.number().int(),
    label_id: z.number().int()
  }, async ({ card_id, label_id }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const label = await mustGet(q.label, label_id, 'Label');
    await db.run('INSERT OR IGNORE INTO card_labels (card_id, label_id, uid, updated_at, rev) VALUES (?, ?, ?, {{now}}, ?)',
      [card.id, label.id, crypto.randomUUID(), await nextRev()]);
    await logActivity(label.board_id, card.id, 'label_added', `Added label "${label.name}" to "${card.title}"`);
    return { ok: true, labels: await cardLabels(card.id) };
  });

  tool('unassign_label', 'Remove a label from a card', {
    card_id: z.number().int(),
    label_id: z.number().int()
  }, async ({ card_id, label_id }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    await db.run('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?', [card.id, label_id]);
    return { ok: true, labels: await cardLabels(card.id) };
  });

  // ---- checklists ----

  tool('add_checklist', 'Add a checklist to a card', {
    card_id: z.number().int(),
    title: z.string().optional().describe('Checklist title (default "Checklist")')
  }, async ({ card_id, title }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const clTitle = (title || 'Checklist').trim() || 'Checklist';
    const pos = (await db.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklists WHERE card_id = ?', [card.id])).p;
    const row = await db.one(
      `INSERT INTO checklists (card_id, title, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING id`,
      [card.id, clTitle, pos, crypto.randomUUID(), await nextRev()]
    );
    await logActivity(await boardIdOfCard(card.id), card.id, 'checklist_added', `Added checklist "${clTitle}"`);
    return { id: row.id, card_id: card.id, title: clTitle, position: pos, items: [] };
  });

  tool('add_checklist_item', 'Add an item to a checklist', {
    checklist_id: z.number().int(),
    text: z.string().min(1)
  }, async ({ checklist_id, text }) => {
    const cl = await mustGet('SELECT * FROM checklists WHERE id = ?', checklist_id, 'Checklist');
    const pos = (await db.one('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM checklist_items WHERE checklist_id = ?', [cl.id])).p;
    return db.one(
      `INSERT INTO checklist_items (checklist_id, text, position, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [cl.id, text.trim(), pos, crypto.randomUUID(), await nextRev()]
    );
  });

  tool('set_checklist_item', 'Update a checklist item (edit text, mark done/undone)', {
    item_id: z.number().int(),
    text: z.string().min(1).optional(),
    done: z.boolean().optional()
  }, async ({ item_id, text, done }) => {
    const item = await mustGet('SELECT * FROM checklist_items WHERE id = ?', item_id, 'Checklist item');
    const newText = text !== undefined ? text.trim() : item.text;
    if (!newText) throw new Error('Item text is required');
    const newDone = done !== undefined ? (done ? 1 : 0) : item.done;
    await db.run('UPDATE checklist_items SET text = ?, done = ?, updated_at = {{now}}, rev = ? WHERE id = ?',
      [newText, newDone, await nextRev(), item.id]);
    const cl = await db.one('SELECT * FROM checklists WHERE id = ?', [item.checklist_id]);
    if (newDone !== item.done && newDone) {
      await logActivity(await boardIdOfCard(cl.card_id), cl.card_id, 'item_completed', `Completed "${newText}"`);
    }
    return {
      ...await db.one('SELECT * FROM checklist_items WHERE id = ?', [item.id]),
      progress: await checklistProgress(cl.card_id)
    };
  });

  // ---- attachments ----

  tool('attach_link', 'Attach a link to a card — a local file path or a URL. Stored as a small .url shortcut, so attaching a 200MB installer costs a couple of hundred bytes.', {
    card_id: z.number().int(),
    target: z.string().min(1).describe('A URL (https://…) or an absolute local path (C:\\… or /…)'),
    name: z.string().optional().describe('Display name (defaults to the file/link name)')
  }, async ({ card_id, target, name }) => {
    const card = await mustGet(q.card, card_id, 'Card');
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
    const row = await db.one(
      `INSERT INTO attachments (card_id, filename, original_name, size, mime, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [card.id, filename, `${safe}.url`, Buffer.byteLength(body), 'application/internet-shortcut',
       crypto.randomUUID(), await nextRev()]
    );
    await logActivity(await boardIdOfCard(card.id), card.id, 'attachment_added', `Attached ${safe}`);
    return { ...row, target: href };
  });

  tool('list_attachments', 'List a card\'s attachments', {
    card_id: z.number().int()
  }, async ({ card_id }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    return (await db.all('SELECT * FROM attachments WHERE card_id = ? ORDER BY id', [card.id]))
      .map((a) => ({ ...a, url: `/uploads/${a.filename}` }));
  });

  tool('delete_attachment', 'Remove an attachment from a card', {
    attachment_id: z.number().int()
  }, async ({ attachment_id }) => {
    const row = await mustGet('SELECT * FROM attachments WHERE id = ?', attachment_id, 'Attachment');
    await db.run('DELETE FROM attachments WHERE id = ?', [row.id]);
    try { fs.unlinkSync(path.join(uploadsDir, row.filename)); } catch {}
    return { ok: true, deleted: row.original_name };
  });

  // ---- comments ----

  tool('add_comment', 'Add a comment to a card', {
    card_id: z.number().int(),
    body: z.string().min(1),
    author: z.string().optional().describe('Comment author (default "Admin")')
  }, async ({ card_id, body, author }) => {
    const card = await mustGet(q.card, card_id, 'Card');
    const name = (author || 'Admin').trim() || 'Admin';
    const comment = await db.one(
      `INSERT INTO comments (card_id, author, body, uid, updated_at, rev)
       VALUES (?, ?, ?, ?, {{now}}, ?) RETURNING *`,
      [card.id, name, body.trim(), crypto.randomUUID(), await nextRev()]
    );
    await logActivity(await boardIdOfCard(card.id), card.id, 'comment_added', `Commented on "${card.title}"`);
    return comment;
  });

  return server;
}

module.exports = { createBoardlyServer, resolveDataDir };
