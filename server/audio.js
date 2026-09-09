const express = require('express');
const multer = require('multer');
const { safeText } = require('./agent-activity');
const { accessForMember } = require('./member-access');
const fail = (status, message) => Object.assign(Error(message), { status });
const voices = [{ id: 'af_heart', name: 'Heart · American English' }, { id: 'am_michael', name: 'Michael · American English' }, { id: 'bf_emma', name: 'Emma · British English' }];

function createAudioRoutes({ config = {}, memberships, request = fetch }) {
  const router = express.Router(), active = new Set(), rates = new Map();
  const base = '/api/audio/:kind(project|company)/:scopeId';
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 2 } });
  function authorize(req) {
    const id = Number(req.params.scopeId), db = req.tenant.app.db, kind = req.params.kind;
    if (!Number.isSafeInteger(id) || id < 1) throw fail(404, 'Company or project not found');
    const scope = db.prepare(`SELECT id FROM ${kind === 'company' ? 'companies' : 'boards'} WHERE id=?`).get(id);
    if (!scope) throw fail(404, 'Company or project not found');
    if (!req.workspaceIsOwner) {
      // Company AI follows the existing owner-only company discussion access.
      if (kind === 'company') throw fail(403, 'Company AI is managed by the account owner');
      const access = accessForMember(db, memberships.grants(req.workspaceOwnerId, req.cloudUserId));
      if (!access.project(id)) throw fail(404, 'Project not found');
      if (access.project(id) !== 'editor') throw fail(403, 'This project is shared with view-only access');
    }
    return { db, id, kind };
  }
  router.use(base, (req, res, next) => {
    try { authorize(req); res.set('Cache-Control', 'private, no-store'); next(); } catch (e) { next(e); }
  });
  async function provider(path, init, signal) {
    if (!config.url) throw fail(503, 'Audio is not connected yet');
    const response = await request(config.url.replace(/\/$/, '') + path, {
      ...init, headers: { ...init?.headers, ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)])
    });
    if (!response.ok) throw fail(response.status === 422 ? 400 : 503, response.status === 422 ? 'That recording or reply could not be converted. Please try again.' : 'The voice service is unavailable. Please try again shortly.');
    return response;
  }
  const route = fn => async (req, res, next) => {
    const key = req.cloudUserId;
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    try {
      const scope = authorize(req);
      if (active.has(key) || active.size >= 3) throw fail(429, 'Audio is busy. Please try again shortly.');
      const now = Date.now();
      for (const [id, value] of rates) if (value.until <= now) rates.delete(id);
      const rate = rates.get(key) || { until: now + 60000, count: 0 };
      if (rate.count >= 20) throw fail(429, 'Please wait a moment before requesting more audio.');
      rate.count++; rates.set(key, rate); active.add(key); res.once('close', cancel);
      try { await fn(req, res, scope, controller.signal); }
      finally { active.delete(key); res.off('close', cancel); }
    } catch (e) { if (!res.destroyed) next(e.status ? e : fail(503, 'Audio was interrupted. Please try again.')); }
  };
  router.get(base + '/status', async (req, res, next) => {
    try {
      authorize(req);
      let available = false;
      if (config.url) try {
        const response = await request(config.url.replace(/\/$/, '') + '/v1/models', { headers: config.token ? { authorization: `Bearer ${config.token}` } : {}, signal: AbortSignal.timeout(3000) });
        if (response.ok) { const models = (await response.json()).data || []; available = ['speaches-ai/Kokoro-82M-v1.0-ONNX', 'Systran/faster-whisper-small.en'].every(id => models.some(m => m.id === id)); }
      } catch {}
      authorize(req);
      res.json({ available, voices });
    } catch (e) { next(e); }
  });
  router.post(base + '/transcribe', upload.single('audio'), route(async (req, res, scope, signal) => {
    if (!req.file?.buffer.length) throw fail(400, 'Record a question first');
    const mime = req.file.mimetype.split(';')[0];
    const extensions = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };
    if (!extensions[mime]) throw fail(400, 'Use a supported audio recording');
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: mime }), `question.${extensions[mime]}`);
    form.append('model', 'Systran/faster-whisper-small.en');
    form.append('response_format', 'json'); form.append('language', 'en');
    const response = await provider('/v1/audio/transcriptions', { method: 'POST', body: form }, signal);
    const data = await response.json(); authorize(req);
    const text = typeof data.text === 'string' ? safeText(data.text).trim().slice(0, 6000) : '';
    if (!text) throw fail(422, 'No speech was heard. Please try again.');
    res.json({ text });
  }));
  router.post(base + '/speech', express.json({ limit: '4kb' }), route(async (req, res, { db, id, kind }, signal) => {
    const { reply_id, voice = 'af_heart' } = req.body || {};
    if (typeof reply_id !== 'string' || reply_id.length > 100 || !voices.some(v => v.id === voice)) throw fail(400, 'Choose a saved AI reply and voice');
    const row = kind === 'project'
      ? db.prepare("SELECT m.content FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE m.id=? AND t.board_id=? AND m.role='assistant'").get(reply_id, id)
      : db.prepare("SELECT j.draft AS content FROM discussion_jobs j JOIN discussion_threads t ON t.id=j.thread_id WHERE j.id=? AND t.scope_type='company' AND t.scope_id=? AND j.status='completed'").get(reply_id, id);
    if (!row) throw fail(404, 'Saved AI reply not found in this company or project');
    const ids = kind === 'project' ? [id] : req.tenant.chat.organization.scope('company', id).projects.map(p => p.id);
    let text = safeText(row.content);
    for (const projectId of ids) text = req.tenant.environment.redact(projectId, req.tenant.payments.redact(projectId, text));
    text = req.tenant.github.redact(req.tenant.ssh.redact(req.tenant.email.clean(text)));
    text = text.replace(/```[\s\S]*?```/g, ' Code is available in the written reply. ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/^[\s]*[>#*\-]+\s*/gm, '').replace(/[*_`]/g, '').trim();
    if (!text) throw fail(400, 'This reply has no spoken text');
    if (text.length > 6500) throw fail(400, 'This reply is too long to read aloud. Ask for a shorter summary.');
    const response = await provider('/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice, input: text, response_format: 'mp3', speed: 1 }) }, signal);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) throw fail(502, 'Audio reply is too large'); chunks.push(chunk); }
    authorize(req);
    res.type('audio/mpeg').send(Buffer.concat(chunks));
  }));
  router.use((e, req, res, next) => {
    if (!req.path.startsWith('/api/audio/')) return next(e);
    res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : e.status || 400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Keep voice recordings under one minute.' : e.status ? e.message : 'The audio request could not be read.' });
  });
  return router;
}
module.exports = { createAudioRoutes };
