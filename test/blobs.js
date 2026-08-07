// Blob sync test — attachment *bytes* moving through the sync endpoints.
// Topology mirrors production: a cloud app (forced cloud mode locally, real
// Postgres when DATABASE_URL is set) and two desktop apps on SQLite.
// Covers: desktop → cloud upload, cloud → second-desktop download, the
// storage_enabled=0 gate (metadata still syncs, blobs pend silently), and
// the upload cap. Run: node test/blobs.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/app');

const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-blob-cloud-'));
const desk1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-blob-desk1-'));
const desk2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-blob-desk2-'));

let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

function client(base) {
  let cookie = '';
  return {
    base,
    cookie: () => cookie,
    async api(method, url, body, opts = {}) {
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
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
  };
}

async function boot(opts) {
  const app = await createApp(opts);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  return { app, listener, base: `http://127.0.0.1:${listener.address().port}` };
}

function attachmentBody(bytes, name) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'text/plain' }), name);
  return form;
}

async function main() {
  // 1MB cloud cap so the oversize check uses a small file.
  const cloudOpts = process.env.DATABASE_URL
    ? { dataDir: cloudDir, maxUploadMb: 1 }
    : { dataDir: cloudDir, mode: 'cloud', maxUploadMb: 1 };
  const cloud = await boot(cloudOpts);
  const desk1 = await boot({ dataDir: desk1Dir, adminPassword: 'admin', databaseUrl: null });
  const desk2 = await boot({ dataDir: desk2Dir, adminPassword: 'admin', databaseUrl: null });
  const C = client(cloud.base);
  const D1 = client(desk1.base);
  const D2 = client(desk2.base);
  const cloudStore = cloud.app.locals.store;

  try {
    await C.api('POST', '/api/register', { email: `blob-${Date.now()}@test.dev`, password: 'password-123' });
    const token = (await C.api('POST', '/api/tokens', { name: 'sync' })).json.token;
    await D1.api('POST', '/api/login', { password: 'admin' });
    await D2.api('POST', '/api/login', { password: 'admin' });

    // ---- desk1 authors a card with an attachment ----
    const board = (await D1.api('POST', '/api/boards', { name: 'Blob board' })).json;
    const list = (await D1.api('POST', `/api/boards/${board.id}/lists`, { name: 'Todo' })).json;
    const card = (await D1.api('POST', `/api/lists/${list.id}/cards`, { title: 'Has files' })).json;
    const bytes1 = Buffer.from('blob-one-' + Date.now());
    const att1 = (await D1.api('POST', `/api/cards/${card.id}/attachments`, attachmentBody(bytes1, 'one.txt'))).json;
    assert(att1.uid, 'attachment has a uid');

    // ---- connect desk1 → metadata + blob land on the cloud ----
    await D1.api('POST', '/api/sync/connect', { url: cloud.base, token });
    const got1 = await C.api('GET', `/api/sync/blob/${att1.uid}`, undefined, { raw: true });
    assert.equal(got1.status, 200, 'cloud serves the blob');
    assert(Buffer.from(await got1.arrayBuffer()).equals(bytes1), 'bytes identical');
    ok('blob uploads desktop → cloud during sync');

    // ---- desk2 connects → metadata pulls, then the bytes download ----
    await D2.api('POST', '/api/sync/connect', { url: cloud.base, token });
    const d2Boards = (await D2.api('GET', '/api/boards')).json;
    const d2Board = (await D2.api('GET', `/api/boards/${d2Boards[0].id}`)).json;
    const d2CardId = d2Board.lists[0].cards[0].id;
    const d2Detail = (await D2.api('GET', `/api/cards/${d2CardId}`)).json;
    assert.equal(d2Detail.attachments.length, 1, 'metadata synced to desk2');
    const d2File = path.join(desk2Dir, 'uploads', d2Detail.attachments[0].filename);
    assert(fs.existsSync(d2File), 'blob file present on desk2');
    assert(fs.readFileSync(d2File).equals(bytes1), 'desk2 bytes identical');
    ok('blob downloads cloud → second desktop (full round trip)');

    // ---- storage gate: flag off → 403, metadata keeps flowing, blobs pend ----
    await cloudStore.run('UPDATE users SET storage_enabled = 0');
    const bytes2 = Buffer.from('blob-two-' + Date.now());
    const att2 = (await D1.api('POST', `/api/cards/${card.id}/attachments`, attachmentBody(bytes2, 'two.txt'))).json;
    const st = (await D1.api('POST', '/api/sync/now')).json;
    assert.equal(st.state, 'idle', 'sync itself is not an error');
    assert(st.pendingBlobs >= 1, 'blob marked pending');
    const forbidden = await C.api('GET', `/api/sync/blob/${att2.uid}`, undefined, { raw: true });
    assert.equal(forbidden.status, 403, 'blob endpoints 403 with storage off');
    const cloudBoardId = (await C.api('GET', '/api/boards')).json.find((b) => b.name === 'Blob board').id;
    const cloudDetail = (await C.api('GET', `/api/boards/${cloudBoardId}`)).json;
    const cloudCard = cloudDetail.lists[0].cards[0];
    const cloudCardDetail = (await C.api('GET', `/api/cards/${cloudCard.id}`)).json;
    assert.equal(cloudCardDetail.attachments.length, 2, 'attachment metadata still synced');
    ok('storage_enabled=0 → blobs 403 + pend, metadata syncs');

    // ---- flag back on → pending blob uploads on the next sync ----
    await cloudStore.run('UPDATE users SET storage_enabled = 1');
    const st2 = (await D1.api('POST', '/api/sync/now')).json;
    assert.equal(st2.pendingBlobs, 0, 'pending cleared');
    const got2 = await C.api('GET', `/api/sync/blob/${att2.uid}`, undefined, { raw: true });
    assert.equal(got2.status, 200);
    ok('re-enabling storage lets pending blobs upload');

    // ---- over the cap: client pends it, server rejects a direct post ----
    const big = Buffer.alloc(2 * 1024 * 1024, 7); // 2MB > 1MB cloud cap
    const att3 = (await D1.api('POST', `/api/cards/${card.id}/attachments`, attachmentBody(big, 'big.bin'))).json;
    const st3 = (await D1.api('POST', '/api/sync/now')).json;
    assert(st3.pendingBlobs >= 1, 'oversize blob stays pending');
    const direct = await fetch(`${cloud.base}/api/sync/blob/${att3.uid}`, {
      method: 'POST',
      headers: { cookie: C.cookie(), 'content-type': 'application/octet-stream' },
      body: big
    });
    assert.equal(direct.status, 413, 'server rejects oversize blob with 413');
    ok('upload cap respected on both sides of the blob endpoint');

    console.log(`\nAll ${pass} blob-sync checks passed.`);
  } finally {
    await desk1.app.stopSync?.();
    await desk2.app.stopSync?.();
    cloud.listener.close();
    desk1.listener.close();
    desk2.listener.close();
    for (const d of [cloudDir, desk1Dir, desk2Dir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((e) => {
  console.error('\nBLOB SYNC TEST FAILED:', e);
  process.exit(1);
});
