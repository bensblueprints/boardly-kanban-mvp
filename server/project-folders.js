const crypto = require('node:crypto');
const fail = (status, message) => Object.assign(Error(message), { status });

function installFolders(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES project_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS project_folder_names ON project_folders(board_id,COALESCE(parent_id,0),name COLLATE NOCASE);`);
  if (!db.prepare('PRAGMA table_info(project_files)').all().some(c => c.name === 'folder_id')) {
    db.exec('ALTER TABLE project_files ADD COLUMN folder_id INTEGER REFERENCES project_folders(id) ON DELETE SET NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS project_file_folder ON project_files(board_id,folder_id)');
}
function folderId(db, boardId, value) {
  if (value === null || value === undefined || value === '') return null;
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) throw fail(400, 'Choose a valid folder');
  if (!db.prepare('SELECT id FROM project_folders WHERE id=? AND board_id=?').get(id, boardId)) throw fail(404, 'Folder not found in this project');
  return id;
}
function folderName(value) {
  if (typeof value !== 'string') throw fail(400, 'Enter a folder name');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 120 || ['.', '..'].includes(name) || /[\/\\\x00-\x1f\x7f]/.test(name)) throw fail(400, 'Use a folder name of 1–120 characters without slashes or control characters');
  return name;
}
function listFolders(db, boardId) {
  const rows = db.prepare('SELECT * FROM project_folders WHERE board_id=? ORDER BY name COLLATE NOCASE,id').all(boardId);
  const byId = new Map(rows.map(f => [f.id, f]));
  return rows.map(f => {
    const parts = [f.name], seen = new Set([f.id]); let parent = byId.get(f.parent_id);
    while (parent && !seen.has(parent.id)) { parts.unshift(parent.name); seen.add(parent.id); parent = byId.get(parent.parent_id); }
    return { ...f, path: parts.join('/') };
  });
}
function listFiles(db, boardId) {
  const folders = new Map(listFolders(db, boardId).map(f => [f.id, f.path]));
  return db.prepare('SELECT * FROM project_files WHERE board_id=? ORDER BY created_at DESC,id DESC').all(boardId)
    .map(f => ({ ...f, folder_path: folders.get(f.folder_id) || '' }));
}
function createFolder(db, boardId, name, parentId = null) {
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(boardId)) throw fail(404, 'Project not found');
  name = folderName(name); parentId = folderId(db, boardId, parentId);
  let parent = parentId, depth = 0;
  while (parent !== null) { if (++depth >= 20) throw fail(400, 'Folders can be nested up to 20 levels'); parent = db.prepare('SELECT parent_id FROM project_folders WHERE id=?').get(parent).parent_id; }
  if (db.prepare('SELECT id FROM project_folders WHERE board_id=? AND parent_id IS ? AND name=? COLLATE NOCASE').get(boardId, parentId, name)) throw fail(409, 'A folder with that name already exists here');
  const id = db.prepare('INSERT INTO project_folders(uuid,board_id,parent_id,name,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), boardId, parentId, name, Date.now()).lastInsertRowid;
  return db.prepare('SELECT * FROM project_folders WHERE id=?').get(id);
}
function renameFolder(db, id, name) {
  const row = db.prepare('SELECT * FROM project_folders WHERE id=?').get(id);
  if (!row) throw fail(404, 'Folder not found');
  name = folderName(name);
  if (db.prepare('SELECT id FROM project_folders WHERE board_id=? AND parent_id IS ? AND name=? COLLATE NOCASE AND id!=?').get(row.board_id, row.parent_id, name, id)) throw fail(409, 'A folder with that name already exists here');
  db.prepare('UPDATE project_folders SET name=? WHERE id=?').run(name, id);
  return { ...row, name };
}
function deleteFolder(db, id) {
  if (!db.prepare('SELECT id FROM project_folders WHERE id=?').get(id)) throw fail(404, 'Folder not found');
  if (db.prepare('SELECT id FROM project_files WHERE folder_id=?').get(id) || db.prepare('SELECT id FROM project_folders WHERE parent_id=?').get(id)) throw fail(409, 'Move the files and remove subfolders before deleting this folder');
  db.prepare('DELETE FROM project_folders WHERE id=?').run(id);
  return { ok: true };
}
function moveFile(db, id, destination) {
  const row = db.prepare('SELECT * FROM project_files WHERE id=?').get(id);
  if (!row) throw fail(404, 'File not found');
  const target = folderId(db, row.board_id, destination);
  db.prepare('UPDATE project_files SET folder_id=? WHERE id=?').run(target, id);
  return { ...row, folder_id: target };
}
module.exports = { installFolders, folderId, listFolders, listFiles, createFolder, renameFolder, deleteFolder, moveFile };
