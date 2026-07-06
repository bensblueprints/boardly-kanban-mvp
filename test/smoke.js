// Boardly smoke test — boots the real server on a throwaway data dir and
// exercises the full API surface end to end. Run with `npm test`.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-smoke-'));
const app = createApp({ dataDir, adminPassword: 'smoke-pass' });

let cookie = '';
let base = '';

async function api(method, url, body, opts = {}) {
  const headers = { cookie };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (opts.raw) return res;
  const json = await res.json();
  if (!res.ok && !opts.allowError) {
    throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// strips volatile fields so exports can be deep-compared
function normalizeExport(e) {
  const clone = JSON.parse(JSON.stringify(e));
  delete clone.exported_at;
  for (const l of clone.lists) {
    for (const c of l.cards) delete c.created_at;
    for (const c of l.cards) for (const cm of c.comments || []) delete cm.created_at;
  }
  return clone;
}

async function main() {
  const listener = await new Promise((resolve) => {
    const l = app.listen(0, '127.0.0.1', () => resolve(l));
  });
  base = `http://127.0.0.1:${listener.address().port}`;
  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

  try {
    // ---- auth ----
    const bad = await api('POST', '/api/login', { password: 'wrong' }, { allowError: true });
    assert(bad.error, 'wrong password rejected');
    cookie = '';
    await api('POST', '/api/login', { password: 'smoke-pass' });
    const me = await api('GET', '/api/me');
    assert.equal(me.authed, true);
    ok('auth: login + session');

    // ---- board / lists / cards ----
    const board = await api('POST', '/api/boards', { name: 'Launch Plan', color: '#f59e0b', emoji: '🚀' });
    assert(board.id && board.emoji === '🚀');
    const todo = await api('POST', `/api/boards/${board.id}/lists`, { name: 'To Do' });
    const doing = await api('POST', `/api/boards/${board.id}/lists`, { name: 'Doing' });
    const done = await api('POST', `/api/boards/${board.id}/lists`, { name: 'Done' });
    const cards = [];
    for (const t of ['Write copy', 'Design logo', 'Ship v1']) {
      cards.push(await api('POST', `/api/lists/${todo.id}/cards`, { title: t }));
    }
    let full = await api('GET', `/api/boards/${board.id}`);
    assert.equal(full.lists.length, 3);
    assert.deepEqual(full.lists[0].cards.map((c) => c.title), ['Write copy', 'Design logo', 'Ship v1']);
    ok('create board / lists / cards via API');

    // star + favorites ordering
    await api('PATCH', `/api/boards/${board.id}`, { starred: true });
    const boards = await api('GET', '/api/boards');
    assert.equal(boards[0].id, board.id);
    assert.equal(boards[0].starred, 1);
    ok('board star favorite');

    // ---- move card between lists + reorder, order persists exactly ----
    // move "Design logo" to Doing at index 0
    await api('POST', `/api/cards/${cards[1].id}/move`, { list_id: doing.id, position: 0 });
    // reorder within To Do: move "Ship v1" above "Write copy"
    await api('POST', `/api/cards/${cards[2].id}/move`, { list_id: todo.id, position: 0 });
    full = await api('GET', `/api/boards/${board.id}`);
    const listById = Object.fromEntries(full.lists.map((l) => [l.id, l]));
    assert.deepEqual(listById[todo.id].cards.map((c) => c.title), ['Ship v1', 'Write copy']);
    assert.deepEqual(listById[doing.id].cards.map((c) => c.title), ['Design logo']);
    // re-fetch again to prove persistence (fresh read, same order)
    const refetch = await api('GET', `/api/boards/${board.id}`);
    assert.deepEqual(
      refetch.lists.map((l) => l.cards.map((c) => c.title)),
      full.lists.map((l) => l.cards.map((c) => c.title))
    );
    assert.deepEqual(listById[todo.id].cards.map((c) => c.position), [0, 1]);
    ok('move card between lists + reorder persists exactly on re-fetch');

    // list reorder
    await api('POST', `/api/boards/${board.id}/lists/reorder`, { order: [done.id, todo.id, doing.id] });
    full = await api('GET', `/api/boards/${board.id}`);
    assert.deepEqual(full.lists.map((l) => l.name), ['Done', 'To Do', 'Doing']);
    ok('list drag-reorder persists');

    // ---- checklist + progress ----
    const card = cards[0]; // Write copy
    const cl = await api('POST', `/api/cards/${card.id}/checklists`, { title: 'Steps' });
    const i1 = await api('POST', `/api/checklists/${cl.id}/items`, { text: 'Draft' });
    await api('POST', `/api/checklists/${cl.id}/items`, { text: 'Review' });
    let detail = await api('GET', `/api/cards/${card.id}`);
    assert.equal(detail.checklists[0].items.length, 2);
    const toggled = await api('PATCH', `/api/checklist-items/${i1.id}`, { done: true });
    assert.deepEqual(toggled.progress, { total: 2, done: 1 });
    full = await api('GET', `/api/boards/${board.id}`);
    const summary = full.lists.flatMap((l) => l.cards).find((c) => c.id === card.id);
    assert.deepEqual(summary.checklist, { total: 2, done: 1 });
    ok('checklist item toggle updates progress');

    // ---- labels + filter endpoint ----
    const urgent = await api('POST', `/api/boards/${board.id}/labels`, { name: 'Urgent', color: '#ef4444' });
    await api('POST', `/api/boards/${board.id}/labels`, { name: 'Design', color: '#8b5cf6' });
    await api('POST', `/api/cards/${card.id}/labels/${urgent.id}`);
    const filtered = await api('GET', `/api/boards/${board.id}/cards?label=${urgent.id}`);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, card.id);
    assert.equal(filtered[0].labels[0].name, 'Urgent');
    ok('label filter endpoint');

    // due date filters + search
    await api('PATCH', `/api/cards/${card.id}`, { due_date: '2020-01-01T10:00' });
    const overdue = await api('GET', `/api/boards/${board.id}/cards?due=overdue`);
    assert.equal(overdue.length, 1);
    const searched = await api('GET', `/api/boards/${board.id}/cards?q=ship`);
    assert.equal(searched.length, 1);
    assert.equal(searched[0].title, 'Ship v1');
    ok('due-date filter + search');

    // ---- comments + activity ----
    const comment = await api('POST', `/api/cards/${card.id}/comments`, { body: 'Looks good, shipping it.' });
    assert(comment.id);
    detail = await api('GET', `/api/cards/${card.id}`);
    assert.equal(detail.comments.length, 1);
    assert(detail.activity.length > 0, 'card has activity rows');
    const boardActivity = await api('GET', `/api/boards/${board.id}/activity`);
    const actions = boardActivity.map((a) => a.action);
    for (const expected of ['board_created', 'card_created', 'card_moved', 'comment_added', 'item_completed', 'label_added']) {
      assert(actions.includes(expected), `activity includes ${expected}`);
    }
    ok('comment + activity rows created (card + board)');

    // ---- attachment upload → served back with correct bytes ----
    const bytes = Buffer.from(`boardly-attachment-${Date.now()}-\x00\x01\x02binary`, 'utf8');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/plain' }), 'notes.txt');
    const att = await api('POST', `/api/cards/${card.id}/attachments`, form);
    assert.equal(att.original_name, 'notes.txt');
    const served = await api('GET', att.url, undefined, { raw: true });
    assert.equal(served.status, 200);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    assert(servedBytes.equals(bytes), 'served attachment bytes match uploaded bytes');
    ok('attachment upload → served back with correct bytes');

    // ---- archive card: excluded from board fetch, restorable ----
    const shipCard = cards[2];
    await api('PATCH', `/api/cards/${shipCard.id}`, { archived: true });
    full = await api('GET', `/api/boards/${board.id}`);
    assert(!full.lists.flatMap((l) => l.cards).some((c) => c.id === shipCard.id), 'archived card hidden');
    const archived = await api('GET', `/api/boards/${board.id}/archived`);
    assert(archived.cards.some((c) => c.id === shipCard.id), 'archived card listed');
    await api('PATCH', `/api/cards/${shipCard.id}`, { archived: false });
    full = await api('GET', `/api/boards/${board.id}`);
    assert(full.lists.flatMap((l) => l.cards).some((c) => c.id === shipCard.id), 'card restored');
    // archive a list too
    await api('PATCH', `/api/lists/${done.id}`, { archived: true });
    full = await api('GET', `/api/boards/${board.id}`);
    assert.equal(full.lists.length, 2);
    await api('PATCH', `/api/lists/${done.id}`, { archived: false });
    ok('archive card + list excluded from fetch, restorable');

    // ---- export → import → deep-equal round trip ----
    const exported = await api('GET', `/api/boards/${board.id}/export`);
    assert.equal(exported.app, 'boardly');
    const imported = await api('POST', '/api/boards/import', exported);
    assert(imported.id && imported.id !== board.id);
    const reExported = await api('GET', `/api/boards/${imported.id}/export`);
    assert.deepEqual(normalizeExport(reExported), normalizeExport(exported),
      'imported board exports deep-equal to original (minus IDs/timestamps)');
    // attachment bytes survived the round trip
    const importedFull = await api('GET', `/api/boards/${imported.id}`);
    const importedCard = importedFull.lists.flatMap((l) => l.cards).find((c) => c.title === 'Write copy');
    const importedDetail = await api('GET', `/api/cards/${importedCard.id}`);
    const impAtt = importedDetail.attachments[0];
    const impServed = await api('GET', `/uploads/${impAtt.filename}`, undefined, { raw: true });
    assert(Buffer.from(await impServed.arrayBuffer()).equals(bytes), 'imported attachment bytes intact');
    ok('export JSON → import → deep-equal round trip (incl. attachment bytes)');

    // ---- auth gate ----
    const saved = cookie;
    cookie = '';
    const denied = await api('GET', '/api/boards', undefined, { raw: true });
    assert.equal(denied.status, 401);
    cookie = saved;
    ok('unauthenticated requests rejected');

    console.log(`\nAll ${passed} smoke checks passed.`);
  } finally {
    listener.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('\nSMOKE TEST FAILED:', e);
  process.exit(1);
});
