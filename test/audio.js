const assert = require('node:assert/strict'), http = require('node:http'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { fixture } = require('./member-fixture');
const { workspacePath } = require('../server/cloud');
const { snapshot } = require('../server/agent-scheduling');
let f, server, db, releasePending;
(async () => {
  const seen = []; let delay = null, received = null;
  server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: ['speaches-ai/Kokoro-82M-v1.0-ONNX', 'Systran/faster-whisper-small.en'].map(id => ({ id })) })); return; }
    assert.equal(req.headers.authorization, 'Bearer private-audio-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    received?.(); if (delay) await delay;
    if (req.url === '/v1/audio/speech') { res.setHeader('content-type', 'audio/mpeg'); res.end('ID3fixture-audio'); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'What should we do next?' })); }
  }).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  f = await fixture({ audio: { url: `http://127.0.0.1:${server.address().port}`, token: 'private-audio-token' } });
  const a = await f.project('Company A', 'Project A'), b = await f.project('Company B', 'Project B');
  const member = (await f.api(`/api/projects/${a.project.id}/members`, { method: 'POST', body: { email: 'editor@example.com', role: 'editor' } })).member;
  const viewer = (await f.api(`/api/projects/${a.project.id}/members`, { method: 'POST', body: { email: 'viewer@example.com', role: 'viewer' } })).member;
  const outsider = (await f.api(`/api/projects/${b.project.id}/members`, { method: 'POST', body: { email: 'outsider@example.com', role: 'editor' } })).member;
  db = new Database(path.join(workspacePath(f.root, 'user_owner'), 'app.db'));
  const t = await f.api(`/api/boards/${a.project.id}/chat/threads`, { method: 'POST', body: { title: 'Audio briefing' } });
  const reply = crypto.randomUUID();
  const secret = 'sensitive-project-value-for-audio-test';
  await f.api(`/api/boards/${a.project.id}/environment/SAMPLE_SECRET`, { method: 'PUT', body: { value: secret } });
  db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run(reply, t.id, 'assistant', `**Review the homepage.** ${secret}`, Date.now());
  const base = `/api/audio/project/${a.project.id}`;
  assert.equal((await f.api(base + '/status')).available, true);
  let response = await f.request(base + '/speech', { method: 'POST', body: { reply_id: reply } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/mpeg'); assert.equal(await response.text(), 'ID3fixture-audio');
  assert.ok(!seen.at(-1).body.includes(secret)); assert.ok(JSON.parse(seen.at(-1).body).input.includes('Review the homepage.'));
  const count = seen.length;
  for (const options of [
    { user: viewer.user_id }, { user: outsider.user_id },
    { user: member.user_id, workspace: outsider.user_id }
  ]) assert.ok([403, 404].includes((await f.request(base + '/speech', { ...options, method: 'POST', body: { reply_id: reply } })).status));
  assert.equal((await f.request(`/api/audio/project/${b.project.id}/speech`, { method: 'POST', body: { reply_id: reply } })).status, 404);
  assert.equal((await f.request(base + '/speech', { method: 'POST', body: { input: 'Arbitrary text is not accepted' } })).status, 400);
  assert.equal((await f.request(base + '/speech', { method: 'POST', body: { reply_id: reply, voice: 'not-a-voice' } })).status, 400);
  assert.equal(seen.length, count, 'Rejected requests do not reach the voice service');
  response = await f.request(base + '/speech', { user: member.user_id, method: 'POST', body: { reply_id: reply } });
  assert.equal(response.status, 200); await response.arrayBuffer();
  const recording = new FormData(); recording.append('audio', new Blob(['recording'], { type: 'audio/webm' }), 'question.webm');
  assert.equal((await f.api(base + '/transcribe', { user: member.user_id, method: 'POST', body: recording })).text, 'What should we do next?');
  assert.ok(seen.at(-1).body.includes('Systran/faster-whisper-small.en'));
  assert.equal((await f.request(base + '/transcribe', { method: 'POST', body: new FormData() })).status, 400);
  const invalid = new FormData(); invalid.append('audio', new Blob(['invalid'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await f.request(base + '/transcribe', { method: 'POST', body: invalid })).status, 400);
  const companyThread = await f.api(`/api/agents/company/${a.company.id}/threads`, { method: 'POST', body: { title: 'Audio briefing' } });
  assert.equal(companyThread.title, 'Audio briefing');
  const run = crypto.randomUUID(), now = Date.now();
  db.prepare("INSERT INTO discussion_jobs(id,thread_id,mode,prompt,draft,status,requested_by,runtime,created_at,updated_at) VALUES (?,?,'ask','Brief me','Project A needs approval.','completed','user_owner','codex',?,?)").run(run, companyThread.id, now, now);
  response = await f.request(`/api/audio/company/${a.company.id}/speech`, { method: 'POST', body: { reply_id: run } }); assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal((await f.request(`/api/audio/company/${b.company.id}/speech`, { method: 'POST', body: { reply_id: run } })).status, 404);
  assert.equal((await f.request(`/api/audio/company/${a.company.id}/status`, { user: member.user_id })).status, 403);
  // Board audio must use that board's projects, not its entire parent company.
  const sibling = await f.api('/api/company-boards', { method: 'POST', body: { company_id: a.company.id, name: 'Other board in Company A' } });
  await f.api('/api/projects', { method: 'POST', body: { parent_board_id: sibling.id, name: 'Unrelated sibling project' } });
  const boardBase = `/api/audio/board/${a.board.id}`;
  assert.equal((await f.api(boardBase + '/status')).available, true);
  for (const actor of [member.user_id, viewer.user_id, outsider.user_id]) assert.ok([403, 404].includes((await f.request(boardBase + '/status', { user: actor })).status));
  assert.equal((await f.request('/api/audio/board/999999/status')).status, 404);
  const boardThread = await f.api(`/api/agents/board/${a.board.id}/threads`, { method: 'POST', body: { title: 'Audio briefing' } });
  const asked = await f.api(`/api/discussions/threads/${boardThread.id}/messages`, { method: 'POST', body: { mode: 'ask', content: 'Summarize this board' } });
  const store = require('../server/connections').createConnections(f.root), key = store.issue('user_owner', 'Board audio QA', 'worker'); store.close();
  const worker = async (route, body = {}) => { const r = await fetch(f.base + route, { method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok); return r.json(); };
  const claimed = (await worker('/api/worker/claim')).job;
  assert.equal(claimed.id, asked.id); assert.equal(claimed.mode, 'ask'); assert.equal(claimed.context.scope.kind, 'board');
  assert.deepEqual(claimed.context.projects.map(p => p.project.id), [a.project.id]);
  assert.ok(!JSON.stringify(claimed.context).includes('Unrelated sibling project'));
  await worker(`/api/worker/discussions/${asked.id}`, { status: 'completed', text: `Project A needs approval. ${secret}` });
  response = await f.request(boardBase + '/speech', { method: 'POST', body: { reply_id: asked.id } }); assert.equal(response.status, 200); await response.arrayBuffer();
  assert.ok(!seen.at(-1).body.includes(secret));
  assert.equal((await f.request(boardBase + '/speech', { method: 'POST', body: { reply_id: run } })).status, 404, 'company replies cannot be used as board replies');
  assert.equal((await f.request(`/api/audio/company/${a.company.id}/speech`, { method: 'POST', body: { reply_id: asked.id } })).status, 404, 'board replies cannot be used as company replies');
  assert.equal((await f.request(`/api/audio/board/${sibling.id}/speech`, { method: 'POST', body: { reply_id: asked.id } })).status, 404);
  console.log('PASS: board summary claims only its own projects, saved board audio, board/company reply separation, redaction and member denial');
  // Revocation while speech is being generated must prevent delivery.
  let release; delay = new Promise(r => { release = r; releasePending = r; }); const started = new Promise(r => { received = r; });
  const pending = f.request(base + '/speech', { user: member.user_id, method: 'POST', body: { reply_id: reply } }); await started;
  assert.equal((await f.request(base + '/speech', { user: member.user_id, method: 'POST', body: { reply_id: reply } })).status, 429);
  const grant = (await f.api(`/api/projects/${a.project.id}/members`)).members.find(m => m.email === 'editor@example.com').grant_id;
  await f.api(`/api/memberships/${grant}`, { method: 'DELETE' }); release();
  assert.equal((await pending).status, 404); delay = null; received = null;
  const card = await f.api(`/api/lists/${a.list.id}/cards`, { method: 'POST', body: { title: 'Due task', due_date: '2026-09-10' } });
  const context = snapshot(db, [a.project.id])[0];
  assert.equal(context.tasks.find(c => c.id === card.id).due_date, '2026-09-10'); assert.ok(context.captured_at); assert.equal(context.task_counts.reduce((n, s) => n + s.total, 0), 1);
  console.log('PASS: authenticated audio, scoped saved replies, secret redaction, company/project/member isolation, input validation, concurrency, revocation and summary dates/counts');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { releasePending?.(); db?.close(); if (f) await f.close(); if (server) await new Promise(r => server.close(r)); });
