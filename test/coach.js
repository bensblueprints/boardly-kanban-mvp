// End-to-end test for the voice coach.
// Stands up a mock OpenAI-compatible model + transcription server, points the
// coach at it, and drives the whole path: board context -> model -> parsed plan
// -> checklist written onto the real card. Also covers the messy-output cases
// local models actually produce (fenced JSON, prose around JSON, hallucinated
// card ids) and a dead server.
// Run: node test/coach.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { createApp } = require('../server/app.js');
const coach = require('../server/coach.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-coach-'));
let pass = 0;
const ok = (m) => { console.log('  ok  ' + m); pass++; };

// ---- mock model server -------------------------------------------------
let nextReply = '';
let lastRequest = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      lastRequest = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: nextReply } }] }));
    }
    if (req.url.startsWith('/v1/audio/transcriptions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ text: 'what should I work on next' }));
    }
    res.writeHead(404).end();
  });
});

async function main() {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;

  // A port that is definitely closed: bind one, note it, then release it.
  // (Node refuses port 9 outright as "bad port", which is a different error
  // than a real connection refusal, so we can't just hardcode a low port.)
  const throwaway = http.createServer();
  await new Promise((r) => throwaway.listen(0, '127.0.0.1', r));
  const closedPort = String(throwaway.address().port);
  await new Promise((r) => throwaway.close(r));
  const closedUrl = `http://127.0.0.1:${closedPort}/v1`;

  const app = await createApp({ dataDir, adminPassword: 'admin' });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const base = `http://127.0.0.1:${listener.address().port}`;

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const H = { 'content-type': 'application/json', cookie };
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: H, body: JSON.stringify(b) });

  // ---- a board with real outstanding work ----
  const board = await (await post('/api/boards', { name: 'Launch', emoji: '🚀' })).json();
  const list = await (await post(`/api/boards/${board.id}/lists`, { name: 'Apps' })).json();
  const cardA = await (await post(`/api/lists/${list.id}/cards`, { title: 'Bookslot' })).json();
  const cardB = await (await post(`/api/lists/${list.id}/cards`, { title: 'Deepdesk' })).json();
  const clA = await (await post(`/api/cards/${cardA.id}/checklists`, { title: 'Ship' })).json();
  await post(`/api/checklists/${clA.id}/items`, { text: 'Fix the launch crash' });
  const clB = await (await post(`/api/cards/${cardB.id}/checklists`, { title: 'Ship' })).json();
  await post(`/api/checklists/${clB.id}/items`, { text: 'Fix the installer crash' });
  ok('seeded a board with two unfinished cards');

  // ---- settings ----
  await post('/api/coach/settings', { chatUrl: mockUrl, chatModel: 'test-model', sttUrl: mockUrl });
  const saved = await (await fetch(`${base}/api/coach`, { headers: H })).json();
  assert.strictEqual(saved.chatModel, 'test-model');
  ok('coach settings persist');

  // ---- probe ----
  const probe = await (await post('/api/coach/probe', {})).json();
  assert.ok(probe.chat.ok && probe.chat.hasModel, 'probe should find the model: ' + JSON.stringify(probe));
  ok('probe reports the model server reachable and the model loaded');

  // ---- board context actually reaches the model ----
  nextReply = JSON.stringify({
    card_id: cardA.id, card_title: 'Bookslot',
    why: 'It is closest to shipping.',
    steps: ['Install Bookslot from Windows Installers/Bookslot', 'Confirm a window opens'],
    say: 'Start with Bookslot — it just needs the crash fixed.'
  });
  let res = await (await post('/api/coach/next', { question: 'what next?', board_id: board.id })).json();
  const sent = JSON.stringify(lastRequest.messages);
  assert.ok(sent.includes('Bookslot') && sent.includes('Fix the launch crash'),
    'the real board state is sent to the model');
  assert.strictEqual(res.plan.card_id, cardA.id);
  assert.strictEqual(res.plan.steps.length, 2);
  ok('board context reaches the model and a plan comes back');

  // ---- finished cards are excluded from context ----
  const items = await (await fetch(`${base}/api/cards/${cardB.id}`, { headers: H })).json();
  const itemB = items.checklists[0].items[0];
  await fetch(`${base}/api/checklist-items/${itemB.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ done: true })
  });
  const ctx = coach.buildContext(app.locals?.db || require('../server/db.js').openDb(dataDir), { boardId: board.id });
  const titles = ctx[0].cards.map((c) => c.title);
  assert.ok(titles.includes('Bookslot'), 'unfinished card stays in context');
  assert.ok(!titles.includes('Deepdesk'), 'fully-ticked card drops out of context');
  ok('completed cards are excluded from what-next context');

  // ---- messy model output: fenced JSON with prose around it ----
  nextReply = 'Sure! Here is my plan:\n```json\n' + JSON.stringify({
    card_id: cardA.id, card_title: 'Bookslot', why: 'x',
    steps: ['Do the thing'], say: 'Do the thing.'
  }) + '\n```\nHope that helps!';
  res = await (await post('/api/coach/next', { question: 'q', board_id: board.id })).json();
  assert.strictEqual(res.plan.steps[0], 'Do the thing', 'JSON dug out of fences + prose');
  ok('parses fenced JSON wrapped in prose (what local models actually emit)');

  // ---- the model cannot pick the card at all ----
  // Card choice is made in code, so even if the model names a card that does
  // not exist, the plan still points at a real one. This is the guarantee that
  // stops a local model inventing a product name and sending the user chasing it.
  nextReply = JSON.stringify({
    card_id: 999999, card_title: 'Nonexistent Product', why: 'x', steps: ['a', 'b'], say: 'c'
  });
  res = await (await post('/api/coach/next', { question: 'q', board_id: board.id })).json();
  const real = await (await fetch(`${base}/api/cards/${res.plan.card_id}`, { headers: H })).json();
  assert.ok(real && real.id === res.plan.card_id, 'returned card_id exists on the board');
  assert.notStrictEqual(res.plan.card_id, 999999, 'the model\'s invented id is ignored');
  assert.notStrictEqual(res.plan.card_title, 'Nonexistent Product', 'the model\'s invented title is ignored');
  ok('card choice is made in code, so an invented card id/title cannot leak through');

  // ---- the card's real content reaches the model ----
  // Without this the model only sees a title and invents tools that appear
  // nowhere in the project (it suggested Figma and a non-existent admin panel).
  await fetch(`${base}/api/cards/${cardA.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ description: 'Installer at `Windows Installers/Bookslot/Booking-Page-Setup-1.0.0.exe`' })
  });
  await post(`/api/cards/${cardA.id}/comments`, { body: 'ROOT CAUSE: spawns system node at electron/main.js:43' });
  nextReply = JSON.stringify({ why: 'w', steps: ['a', 'b'], say: 's' });
  await post('/api/coach/next', { question: 'q', board_id: board.id });
  const brief = JSON.stringify(lastRequest.messages);
  assert.ok(brief.includes('Booking-Page-Setup-1.0.0.exe'), 'card description reaches the model');
  assert.ok(brief.includes('electron/main.js:43'), 'card comments reach the model');
  assert.ok(brief.includes('[x]') || brief.includes('[ ]'), 'checklist state reaches the model');
  ok('description, comments and checklist state all reach the model');

  // ---- the whole answer stuffed into one field is recovered ----
  // Observed with qwen2.5:14b: it put a numbered markdown plan in "why" and
  // left steps empty, which used to surface as an unusable answer.
  nextReply = JSON.stringify({
    why: '# Next Steps\n1. Open server/app.js\n2. Fix line 57\n3. Rebuild the installer',
    steps: [], say: ''
  });
  res = await (await post('/api/coach/next', { question: 'q', board_id: board.id })).json();
  assert.ok(res.plan, 'a plan is still produced');
  assert.strictEqual(res.plan.steps.length, 3, 'the numbered list is split back into steps');
  assert.ok(res.plan.steps[0].includes('server/app.js'), 'step content preserved: ' + res.plan.steps[0]);
  assert.ok(!res.plan.steps[0].includes('#'), 'markdown heading stripped');
  ok('an answer crammed into one field is split back into real steps');

  // ---- underscores in identifiers survive cleanup ----
  // Stripping markdown must not mangle ELECTRON_RUN_AS_NODE into ELECTRONRUNASNODE,
  // which would turn a correct instruction into one that silently fails.
  nextReply = JSON.stringify({
    why: '**Fix** the launcher',
    steps: ['Set ELECTRON_RUN_AS_NODE=1 in `electron/main.js`', 'Rebuild the *installer*'],
    say: 'Fix it'
  });
  res = await (await post('/api/coach/next', { question: 'q', board_id: board.id })).json();
  assert.ok(res.plan.steps[0].includes('ELECTRON_RUN_AS_NODE=1'),
    'underscores preserved in identifiers: ' + res.plan.steps[0]);
  assert.ok(!res.plan.steps[0].includes('`'), 'inline code marks removed');
  assert.strictEqual(res.plan.why, 'Fix the launcher', 'markdown emphasis stripped from why');
  ok('markdown cleanup preserves identifiers like ELECTRON_RUN_AS_NODE');

  // ---- a field-name echoed as a value is discarded ----
  nextReply = JSON.stringify({ why: 'actionable_steps', steps: ['do a thing', 'do another'], say: 'go' });
  res = await (await post('/api/coach/next', { question: 'q', board_id: board.id })).json();
  assert.strictEqual(res.plan.why, '', 'a bare field-name in "why" is dropped rather than shown');
  ok('a field name echoed as a value is discarded');

  // ---- only the chosen card is sent to the model ----
  const prompt = JSON.stringify(lastRequest.messages);
  assert.ok(prompt.includes('Bookslot'), 'the chosen card is described to the model');
  assert.ok(!prompt.includes('Deepdesk'), 'other cards are NOT dumped into the prompt');
  ok('only the chosen card reaches the model, not the whole board');

  // ---- non-JSON answer degrades to plain text instead of erroring ----
  nextReply = 'I think you should probably look at Bookslot first.';
  res = await (await post('/api/coach/next', { question: 'q', board_id: board.id })).json();
  assert.strictEqual(res.plan, null);
  assert.ok(res.say.includes('Bookslot'), 'plain prose is still surfaced to the user');
  ok('non-JSON reply degrades gracefully to plain text');

  // ---- apply: steps become a real checklist on the card ----
  const applied = await (await post('/api/coach/apply', {
    card_id: cardA.id, steps: ['Step one', 'Step two', 'Step three'], title: 'Next up'
  })).json();
  assert.strictEqual(applied.count, 3);
  const detail = await (await fetch(`${base}/api/cards/${cardA.id}`, { headers: H })).json();
  const added = detail.checklists.find((c) => c.title === 'Next up');
  assert.ok(added, 'checklist was created on the card');
  assert.deepStrictEqual(added.items.map((i) => i.text), ['Step one', 'Step two', 'Step three']);
  ok('coach steps are written onto the card as a real checklist');

  // ---- transcription path ----
  const fd = new FormData();
  fd.append('audio', new Blob([Buffer.alloc(4096)], { type: 'audio/webm' }), 'speech.webm');
  const tr = await fetch(`${base}/api/coach/transcribe`, { method: 'POST', headers: { cookie }, body: fd });
  const trj = await tr.json();
  assert.strictEqual(trj.text, 'what should I work on next');
  ok('microphone audio round-trips through the transcription server');

  // ---- model list drives the dropdown ----
  const modelList = await (await post('/api/coach/models', { url: mockUrl })).json();
  assert.deepStrictEqual(modelList.models, ['test-model'], 'model list comes back for the picker');
  ok('model list endpoint returns the server\'s models for the dropdown');

  // ---- unreachable server explains itself instead of "fetch failed" ----
  // Port 9 (discard) is closed, so this is a genuine ECONNREFUSED.
  await post('/api/coach/settings', { chatUrl: closedUrl });
  const dead = await post('/api/coach/next', { question: 'q', board_id: board.id });
  assert.strictEqual(dead.status, 502);
  const deadJson = await dead.json();
  assert.ok(deadJson.error, 'error surfaced when the model host is down');
  assert.ok(!/^fetch failed$/i.test(deadJson.error),
    'must not surface the bare "fetch failed" Node throws');
  assert.ok(/nothing is listening/i.test(deadJson.error),
    'connection refused is explained in plain English: ' + deadJson.error);
  assert.ok(deadJson.error.includes(closedPort), 'the error names the host and port it tried');
  ok('connection refused explains what is wrong, not "fetch failed"');

  // ---- and the same for the probe the Test button uses ----
  const badProbe = await (await post('/api/coach/probe', { chatUrl: closedUrl })).json();
  assert.strictEqual(badProbe.chat.ok, false);
  assert.ok(/nothing is listening/i.test(badProbe.chat.error), 'probe explains refusal: ' + badProbe.chat.error);
  ok('Test button reports a real reason for an unreachable server');

  // ---- a hostname that doesn't resolve is a different, named problem ----
  const dnsProbe = await (await post('/api/coach/probe', {
    chatUrl: 'http://this-host-does-not-exist-boardly.invalid:11434/v1'
  })).json();
  assert.strictEqual(dnsProbe.chat.ok, false);
  assert.ok(/resolve/i.test(dnsProbe.chat.error), 'DNS failure named as such: ' + dnsProbe.chat.error);
  ok('unresolvable hostname is reported as a DNS problem, not a refusal');

  // ---- probe uses the values being typed, before Save ----
  const liveProbe = await (await post('/api/coach/probe', { chatUrl: mockUrl, chatModel: 'test-model' })).json();
  assert.ok(liveProbe.chat.ok && liveProbe.chat.hasModel,
    'Test works against unsaved form values');
  ok('Test button probes the typed settings without needing Save first');

  // ---- auth ----
  const noAuth = await fetch(`${base}/api/coach`);
  assert.strictEqual(noAuth.status, 401);
  ok('coach endpoints require auth');

  listener.close();
  mock.close();
  console.log(`\nAll ${pass} coach tests passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('\nFAILED:', e.message); console.error(e.stack); process.exit(1); });
