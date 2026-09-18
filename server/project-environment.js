const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Keep the encryption key outside workspace databases and exports. Back it up
// separately with the server's private configuration.
function loadKey(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'project-secrets.key');
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw Error('Invalid project encryption key');
  return key;
}
const reserved = /^(HOME|PATH|SHELL|USER|LOGNAME|TMPDIR|TEMP|TMP|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|IFS|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|LD_.*|DYLD_.*|CODEX_.*|BOARDLY_.*|SSH_.*|GIT_.*|XDG_.*)$/;
function validName(name) { return typeof name === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(name) && !reserved.test(name); }
function redact(text, values) {
  let result = String(text || '');
  for (const value of Object.values(values).filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')])) {
      if (variant) result = result.split(variant).join('[REDACTED]');
    }
  }
  return result;
}
function createProjectEnvironment({ db, key, namespace }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_environment (
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL, encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id,name)
  )`);
  const aad = (boardId, name) => Buffer.from(JSON.stringify([namespace, Number(boardId), name]));
  const list = boardId => db.prepare('SELECT name,updated_at FROM project_environment WHERE board_id=? ORDER BY name').all(boardId);
  const values = boardId => Object.fromEntries(db.prepare('SELECT * FROM project_environment WHERE board_id=?').all(boardId).map(row => {
    const data = Buffer.from(row.encrypted, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(aad(boardId, row.name)); decipher.setAuthTag(data.subarray(12, 28));
    return [row.name, Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')];
  }));
  const router = express.Router();
  const exists = (req, res, next) => db.prepare('SELECT id FROM boards WHERE id=?').get(req.params.boardId) ? next() : res.status(404).json({ error: 'Project not found' });
  router.get('/api/boards/:boardId/environment', exists, (req, res) => res.json(list(req.params.boardId)));
  router.put('/api/boards/:boardId/environment/:name', exists, express.json({ limit: '24kb' }), (req, res) => {
    const name = req.params.name, value = req.body?.value;
    if (!validName(name)) return res.status(400).json({ error: 'Use an uppercase variable name. System and agent settings are reserved.' });
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 16384 || value.includes('\0')) return res.status(400).json({ error: 'Enter a nonempty value up to 16 KB without null characters' });
    if (list(req.params.boardId).length >= 100 && !list(req.params.boardId).some(v => v.name === name)) return res.status(400).json({ error: 'A project can store up to 100 variables' });
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(req.params.boardId, name));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    db.prepare('INSERT INTO project_environment VALUES (?,?,?,?) ON CONFLICT(board_id,name) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at').run(req.params.boardId, name, encrypted, Date.now());
    res.json({ name, saved: true });
  });
  router.delete('/api/boards/:boardId/environment/:name', exists, (req, res) => {
    if (!db.prepare('DELETE FROM project_environment WHERE board_id=? AND name=?').run(req.params.boardId, req.params.name).changes) return res.status(404).json({ error: 'Variable not found' });
    res.json({ ok: true });
  });
  return { router, list, values, redact: (boardId, text) => redact(text, values(boardId)) };
}
module.exports = { loadKey, validName, redact, createProjectEnvironment };
