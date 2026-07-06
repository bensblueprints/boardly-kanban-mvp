const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function nativeBindingPath() {
  // Under Electron the Node-ABI binding won't load; use the vendored Electron prebuild.
  if (!process.versions.electron) return null;
  const p = path.join(__dirname, '..', 'vendor', 'better_sqlite3-electron.node');
  return fs.existsSync(p) ? p : null;
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const nativeBinding = nativeBindingPath();
  const db = new Database(path.join(dataDir, 'app.db'), nativeBinding ? { nativeBinding } : {});
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1',
      emoji TEXT NOT NULL DEFAULT '📋',
      starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      due_date TEXT DEFAULT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#22c55e'
    );
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    );
    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Checklist',
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT 'Admin',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      card_id INTEGER DEFAULT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id);
    CREATE INDEX IF NOT EXISTS idx_cards_list ON cards(list_id);
    CREATE INDEX IF NOT EXISTS idx_labels_board ON labels(board_id);
    CREATE INDEX IF NOT EXISTS idx_checklists_card ON checklists(card_id);
    CREATE INDEX IF NOT EXISTS idx_items_checklist ON checklist_items(checklist_id);
    CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id);
    CREATE INDEX IF NOT EXISTS idx_activity_board ON activity(board_id);
    CREATE INDEX IF NOT EXISTS idx_activity_card ON activity(card_id);
  `);

  return db;
}

module.exports = { openDb };
