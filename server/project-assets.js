const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const folders = require('./project-folders');

function installProjectAssets(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL, filename TEXT, url TEXT, size INTEGER NOT NULL DEFAULT 0,
    mime TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL, url TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );`);
  folders.installFolders(db);
  require('./task-files').installTaskFiles(db);
}
function safeUrl(value) {
  const u = new URL(String(value));
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw Error('Use an http or https URL without login credentials');
  return u.href;
}
function storageUsage(db, limit = null) {
  const files = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM project_files WHERE filename IS NOT NULL').get().bytes;
  const attachments = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM attachments').get().bytes;
  return { usedBytes: files + attachments, limitBytes: limit, unlimited: limit === null, billingEnabled: false };
}
function addFileLink(db, boardId, name, url, folder = null) {
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(boardId)) throw Error('Project not found');
  const destination = folders.folderId(db, boardId, folder);
  const info = db.prepare('INSERT INTO project_files (uuid,board_id,name,url,created_at,folder_id) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), boardId, String(name).trim().slice(0, 250), safeUrl(url), Date.now(), destination);
  return db.prepare('SELECT * FROM project_files WHERE id=?').get(info.lastInsertRowid);
}
function addProjectLink(db, boardId, title, url, description = '') {
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(boardId)) throw Error('Project not found');
  const info = db.prepare('INSERT INTO project_links (board_id,title,url,description,created_at) VALUES (?,?,?,?,?)')
    .run(boardId, String(title).trim().slice(0, 250), safeUrl(url), String(description).slice(0, 4000), Date.now());
  return db.prepare('SELECT * FROM project_links WHERE id=?').get(info.lastInsertRowid);
}
function createProjectAssets({ db, uploadsDir, limitBytes = null }) {
  installProjectAssets(db);
  const router = express.Router(), json = express.json({ limit: '16kb' });
  const transfers=require('./file-uploads');
  transfers.mountUploadRoutes(router,{base:'/api/boards/:boardId/uploads',service:transfers.createFileUploads({db,uploadsDir}),context:req=>({boardId:Number(req.params.boardId),actor:req.cloudUserId||'local',limit:req.accountPlan?req.accountPlan.storage_bytes:limitBytes,valid:()=>req.revalidateMember?.()})});
  const exists = (req, res, next) => db.prepare('SELECT id FROM boards WHERE id=?').get(req.params.boardId) ? next() : res.status(404).json({ error: 'Project not found' });
  router.get('/api/storage', (req, res) => res.json(storageUsage(db, req.accountPlan ? req.accountPlan.storage_bytes : limitBytes)));
  router.get('/api/boards/:boardId/files', exists, (req, res) => res.json({ files: folders.listFiles(db, req.params.boardId), folders: folders.listFolders(db, req.params.boardId), storage: storageUsage(db, req.accountPlan ? req.accountPlan.storage_bytes : limitBytes) }));
  router.get('/api/boards/:boardId/folders', exists, (req, res) => res.json(folders.listFolders(db, req.params.boardId)));
  router.post('/api/boards/:boardId/folders', exists, json, (req, res, next) => {
    try { res.status(201).json(folders.createFolder(db, req.params.boardId, req.body?.name, req.body?.parent_id)); } catch (e) { next(e); }
  });
  router.patch('/api/project-folders/:id', json, (req, res, next) => {
    try { res.json(folders.renameFolder(db, req.params.id, req.body?.name)); } catch (e) { next(e); }
  });
  router.delete('/api/project-folders/:id', (req, res, next) => {
    try { res.json(folders.deleteFolder(db, req.params.id)); } catch (e) { next(e); }
  });
  router.patch('/api/project-files/:id', json, (req, res, next) => {
    try {
      if (!Object.hasOwn(req.body || {}, 'folder_id')) throw Object.assign(Error('Choose a destination folder'), { status: 400 });
      res.json(folders.moveFile(db, req.params.id, req.body.folder_id));
    } catch (e) { next(e); }
  });
  const storage = multer.diskStorage({ destination: uploadsDir, filename: (req, file, cb) => cb(null, 'project-' + crypto.randomUUID()) });
  router.post('/api/boards/:boardId/files', exists, (req, res, next) => {
    const quota = req.accountPlan ? req.accountPlan.storage_bytes : limitBytes;
    const used = storageUsage(db, quota).usedBytes;
    if (quota !== null && used >= quota) return res.status(413).json({ error: 'Your storage allowance is full' });
    const limits = quota === null ? {} : { fileSize: quota - used };
    multer({ storage, limits }).single('file')(req, res, error => {
      if (error) return next(error);
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload' });
      try {
        const row = db.transaction(() => {
          req.revalidateMember?.();
          const destination = folders.folderId(db, req.params.boardId, req.body?.folder_id);
          if (quota !== null && storageUsage(db).usedBytes + req.file.size > quota) { const e = Error('Your storage allowance is full'); e.status = 413; throw e; }
          const result = db.prepare('INSERT INTO project_files (uuid,board_id,name,filename,size,mime,created_at,folder_id) VALUES (?,?,?,?,?,?,?,?)')
            .run(crypto.randomUUID(), req.params.boardId, req.file.originalname.slice(0, 250), req.file.filename, req.file.size, req.file.mimetype, Date.now(), destination);
          return db.prepare('SELECT * FROM project_files WHERE id=?').get(result.lastInsertRowid);
        })();
        res.status(201).json(row);
      } catch (error) { fs.rmSync(req.file.path, { force: true }); next(error); }
    });
  });
  router.post('/api/boards/:boardId/file-links', exists, json, (req, res) => {
    try {
      if (typeof req.body?.name !== 'string' || !req.body.name.trim()) throw Error('Enter a file name');
      res.status(201).json(addFileLink(db, req.params.boardId, req.body.name, req.body.url, req.body.folder_id));
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  router.get('/api/project-files/:id/download', (req, res) => {
    const row = db.prepare('SELECT * FROM project_files WHERE id=?').get(req.params.id);
    if (!row?.filename) return res.status(404).json({ error: 'Uploaded file not found' });
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.download(path.join(uploadsDir, row.filename), row.name);
  });
  router.delete('/api/project-files/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM project_files WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'File not found' });
    db.prepare('DELETE FROM project_files WHERE id=?').run(row.id);
    if (row.filename) fs.rmSync(path.join(uploadsDir, row.filename), { force: true });
    res.json({ ok: true });
  });
  router.get('/api/boards/:boardId/links', exists, (req, res) => res.json(db.prepare('SELECT * FROM project_links WHERE board_id=? ORDER BY created_at DESC,id DESC').all(req.params.boardId)));
  router.post('/api/boards/:boardId/links', exists, json, (req, res) => {
    try {
      if (typeof req.body?.title !== 'string' || !req.body.title.trim()) throw Error('Enter a link title');
      res.status(201).json(addProjectLink(db, req.params.boardId, req.body.title, req.body.url, req.body.description));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.delete('/api/project-links/:id', (req, res) => {
    if (!db.prepare('DELETE FROM project_links WHERE id=?').run(req.params.id).changes) return res.status(404).json({ error: 'Link not found' });
    res.json({ ok: true });
  });
  return router;
}
module.exports = { installProjectAssets, safeUrl, storageUsage, addFileLink, addProjectLink, createProjectAssets };
