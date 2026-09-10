// End-to-end test for the Whop billing + SMTP email token delivery
// (Phase 4): a tiny local HTTP server plays Whop (memberships API + webhook
// signing), a recording fake mailer plays the SMTP transport, and the real
// sync-server app is driven through the webhook lifecycle, email token
// delivery, the request-token portal, rate limiting, grace expiry, daily
// revalidation, degraded mode, and the not-configured fallback. A focused
// unit test covers createMailer's nodemailer transport options.
// Run from the repo root: node sync-server/test/whop.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { createApp } = require('../app.js');
const { openDb } = require('../db.js');
const { createWhopClient } = require('../whop.js');
const { createMailer } = require('../mailer.js');
const { revalidateOnce } = require('../revalidate.js');

// The not-configured test boots an app from env; make sure no real billing
// env leaks into it.
for (const k of [
  'WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET', 'WHOP_PRODUCT_ID',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM',
]) {
  delete process.env[k];
}

let pass = 0;
function ok(msg) { console.log('  ok  ' + msg); pass++; }

// ---- fake Whop (memberships API only; webhooks are signed locally) ----
function startFakeWhop() {
  const memberships = new Map(); // whop user id -> membership object | null
  const api = {
    // renewsAtMs: epoch ms; emitted as renewal_period_end epoch seconds,
    // matching the Whop v1 API shape.
    setMembership(userId, m) {
      memberships.set(userId, m && {
        id: 'mem_' + userId,
        user_id: userId,
        product_id: 'prod_boardly',
        status: m.valid ? 'active' : 'canceled',
        valid: m.valid,
        renewal_period_end: m.renewsAtMs ? Math.floor(m.renewsAtMs / 1000) : null,
      });
    },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-whop');
    if (req.method === 'GET' && url.pathname === '/api/v1/memberships') {
      const m = memberships.get(url.searchParams.get('user_id'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: m ? [m] : [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      api.base = `http://127.0.0.1:${server.address().port}`;
      api.close = () => server.close();
      resolve(api);
    });
  });
}

// ---- recording fake mailer (same interface as createMailer's return) ----
function createFakeMailer() {
  const sent = [];
  return {
    sent,
    inbox: (to) => sent.filter((m) => m.to === to),
    async sendTokenEmail(to, token) {
      sent.push({ to, token });
    },
  };
}

function signWebhook(rawBody, secret) {
  const id = 'msg_' + crypto.randomBytes(8).toString('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${sig}`,
  };
}

const TOKEN_RE = /bsk_[0-9a-f]{64}/;

async function main() {
  const fakeWhop = await startFakeWhop();
  const fakeMailer = createFakeMailer();
  const whopConfig = {
    apiKey: 'test-api-key',
    webhookSecret: 'test-webhook-secret',
    productId: 'prod_boardly',
    graceDays: 3,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpUser: 'sync@onetimesuite.com',
    smtpPass: 'test-app-password',
    mailFrom: 'Boardly <sync@onetimesuite.com>',
    checkoutUrl: 'http://whop.test/checkout/boardly',
  };
  const whop = createWhopClient(whopConfig, { apiBase: fakeWhop.base });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-whop-'));
  const app = createApp({ dataDir, whop, mailer: fakeMailer });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const db = openDb(dataDir); // second connection for direct assertions/seeds

  const push = (token) => fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: token
      ? { 'content-type': 'application/json', authorization: `Bearer ${token}` }
      : { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: [
      { table: 'cards', uuid: 'c1', updated_at: 1, deleted: false, payload: { title: 't' } },
    ] }),
  });
  const postWebhook = (rawBody, headers, to = base) => fetch(`${to}/webhooks/whop`, {
    method: 'POST', headers, body: rawBody,
  });
  const requestToken = (email) => fetch(`${base}/portal/request-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  // Email comes from data.user.email here (nested extraction path).
  const wentValid = (userId, email, renewsSec) => JSON.stringify({
    type: 'membership.went_valid',
    data: {
      user_id: userId,
      renewal_period_end: renewsSec,
      ...(email ? { user: { id: userId, email } } : {}),
    },
  });

  // ---- webhook went_valid with buyer email: entitlement + emailed token ----
  const renewsSec = Math.floor((Date.now() + 14 * 86400000) / 1000);
  const body1 = wentValid('user-1', 'user-1@example.com', renewsSec);
  const wh1 = await postWebhook(body1, signWebhook(body1, whopConfig.webhookSecret));
  assert.strictEqual(wh1.status, 200, 'signed webhook accepted');
  const acc1 = db.prepare("SELECT id, email FROM accounts WHERE whop_user_id = 'user-1'").get();
  assert.ok(acc1, 'account created');
  assert.strictEqual(acc1.email, 'user-1@example.com', 'buyer email stored from nested payload');
  const ent1 = db.prepare('SELECT * FROM entitlements WHERE account_id = ?').get(acc1.id);
  assert.strictEqual(ent1.status, 'active');
  assert.strictEqual(ent1.renews_at, renewsSec * 1000, 'renews_at stored in ms');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE account_id = ? AND revoked = 0')
      .get(acc1.id).n,
    1,
    'one live token row minted'
  );
  const inbox1 = fakeMailer.inbox('user-1@example.com');
  assert.strictEqual(inbox1.length, 1, 'exactly one token email sent');
  const token1 = TOKEN_RE.exec(inbox1[0].token);
  assert.ok(token1, 'email contains a bsk_ token');
  assert.strictEqual((await push(token1[0])).status, 200, 'emailed token passes the sync gate');
  // Duplicate delivery (Whop is at-least-once): no second email/token.
  const wh1dup = await postWebhook(body1, signWebhook(body1, whopConfig.webhookSecret));
  assert.strictEqual(wh1dup.status, 200);
  assert.strictEqual(fakeMailer.inbox('user-1@example.com').length, 1, 'duplicate went_valid is idempotent');
  ok('webhook went_valid -> entitlement + token emailed once -> token syncs');

  // ---- webhook went_valid without buyer email: entitlement, failure row ----
  const body6 = wentValid('user-6', null, renewsSec);
  const wh6 = await postWebhook(body6, signWebhook(body6, whopConfig.webhookSecret));
  assert.strictEqual(wh6.status, 200, 'email-less payload does not crash the handler');
  const acc6 = db.prepare("SELECT id FROM accounts WHERE whop_user_id = 'user-6'").get();
  assert.ok(acc6, 'account still created');
  assert.strictEqual(
    db.prepare('SELECT status FROM entitlements WHERE account_id = ?').get(acc6.id).status,
    'active',
    'entitlement still activated'
  );
  const fail6 = db.prepare('SELECT * FROM mail_failures WHERE account_id = ?').all(acc6.id);
  assert.strictEqual(fail6.length, 1, 'delivery failure recorded for replay');
  assert.strictEqual(fail6[0].reason, 'no_email_in_payload');
  assert.strictEqual(fakeMailer.sent.length, 1, 'no email attempted');
  ok('webhook without email -> entitlement created, failure recorded, no crash');

  // ---- webhook went_invalid -> grace, sync still passes; then expiry ----
  const body3 = wentValid('user-3', 'user-3@example.com', renewsSec);
  await postWebhook(body3, signWebhook(body3, whopConfig.webhookSecret));
  const acc3 = db.prepare("SELECT id FROM accounts WHERE whop_user_id = 'user-3'").get();
  const token3 = TOKEN_RE.exec(fakeMailer.inbox('user-3@example.com')[0].token)[0];
  const beforeInvalid = Date.now();
  const invalidBody = JSON.stringify({
    type: 'membership.went_invalid',
    data: { user_id: 'user-3', renewal_period_end: renewsSec },
  });
  const wh2 = await postWebhook(invalidBody, signWebhook(invalidBody, whopConfig.webhookSecret));
  assert.strictEqual(wh2.status, 200);
  const ent3b = db.prepare('SELECT * FROM entitlements WHERE account_id = ?').get(acc3.id);
  assert.strictEqual(ent3b.status, 'grace');
  const threeDays = 3 * 86400000;
  assert.ok(
    ent3b.grace_ends_at >= beforeInvalid + threeDays - 5000 &&
    ent3b.grace_ends_at <= Date.now() + threeDays + 5000,
    'grace_ends_at ~= now + 3 days'
  );
  assert.strictEqual((await push(token3)).status, 200, 'grace still passes the gate');
  db.prepare('UPDATE entitlements SET grace_ends_at = ? WHERE account_id = ?')
    .run(Date.now() - 1000, acc3.id);
  const expiredPush = await push(token3);
  assert.strictEqual(expiredPush.status, 403, 'expired grace is rejected');
  assert.strictEqual((await expiredPush.json()).error, 'subscription_inactive');
  assert.strictEqual(
    db.prepare('SELECT status FROM entitlements WHERE account_id = ?').get(acc3.id).status,
    'suspended',
    'row persisted as suspended'
  );
  ok('went_invalid -> grace -> lazy sweep suspends expired grace');

  // ---- webhook: tampered signature -> 401, unknown event -> 200 ----
  const tampered = await postWebhook(body1, signWebhook(body1, 'wrong-secret'));
  assert.strictEqual(tampered.status, 401, 'bad signature rejected');
  const otherBody = JSON.stringify({ type: 'payment.succeeded', data: {} });
  const wh3 = await postWebhook(otherBody, signWebhook(otherBody, whopConfig.webhookSecret));
  assert.strictEqual(wh3.status, 200, 'unknown event acknowledged');
  ok('tampered signature -> 401; unknown event -> 200 ignored');

  // ---- request-token portal: rotate + email, neutral for unknown emails ----
  const portal = await fetch(`${base}/portal`);
  assert.strictEqual(portal.status, 200, 'portal renders');
  const portalHtml = await portal.text();
  assert.ok(/Enter the email you used at checkout/.test(portalHtml), 'email form shown');
  assert.ok(!/oauth|Sign in with Whop/i.test(portalHtml), 'no OAuth remnants');
  assert.ok(portalHtml.includes('http://whop.test/checkout/boardly'), 'checkout link shown when configured');

  const rt1 = await requestToken('user-1@example.com');
  assert.strictEqual(rt1.status, 200);
  assert.ok(/If a Boardly Cloud Sync membership exists/.test(await rt1.text()), 'neutral response');
  const inbox1b = fakeMailer.inbox('user-1@example.com');
  assert.strictEqual(inbox1b.length, 2, 'new token emailed');
  const token1b = TOKEN_RE.exec(inbox1b[1].token)[0];
  assert.notStrictEqual(token1b, token1[0], 'rotated token differs');
  assert.strictEqual((await push(token1[0])).status, 401, 'old token revoked');
  assert.strictEqual((await push(token1b)).status, 200, 'new token works');
  const hashes = db.prepare('SELECT token_hash, revoked FROM tokens').all();
  assert.ok(hashes.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)), 'only sha256 hashes at rest');
  assert.ok(!hashes.some((r) => r.token_hash === token1[0] || r.token_hash === token1b),
    'no plaintext tokens stored');

  const emailsBefore = fakeMailer.sent.length;
  const rt2 = await requestToken('nobody@example.com');
  assert.strictEqual(rt2.status, 200);
  const rt2Html = await rt2.text();
  assert.ok(/If a Boardly Cloud Sync membership exists/.test(rt2Html), 'same neutral page');
  assert.ok(!/no membership|not found|unknown/i.test(rt2Html), 'no existence leak in wording');
  assert.strictEqual(fakeMailer.sent.length, emailsBefore, 'no email for unknown address');
  ok('request-token: known email rotates + emails; unknown email gets identical page, no mail');

  // ---- rate limit: 5 per 10 min per IP, 6th -> 429 ----
  // Two requests already used (rt1, rt2) from this IP.
  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await requestToken(`probe${i}@example.com`)).status, 200, `request ${i + 3} allowed`);
  }
  const rt6 = await requestToken('probe6@example.com');
  assert.strictEqual(rt6.status, 429, '6th request in the window is rate-limited');
  ok('rate limit: 5 requests per 10 min per IP, then 429');

  // ---- revalidateOnce: invalid -> grace -> suspended; valid stays active ----
  const stale = Date.now() - 25 * 3600000;
  const acc4 = Number(db.prepare(
    "INSERT INTO accounts (whop_user_id, created_at) VALUES ('user-4', ?)"
  ).run(Date.now()).lastInsertRowid);
  db.prepare(
    "INSERT INTO entitlements (account_id, status, renews_at, checked_at) VALUES (?, 'active', 111, ?)"
  ).run(acc4, stale);
  fakeWhop.setMembership('user-4', { valid: false });
  const sweep1 = await revalidateOnce(db, whop);
  assert.ok(sweep1.checked >= 1 && sweep1.errors === 0, 'sweep ran without errors');
  const ent4 = db.prepare('SELECT * FROM entitlements WHERE account_id = ?').get(acc4);
  assert.strictEqual(ent4.status, 'grace', 'stale active + invalid membership -> grace');
  assert.ok(ent4.grace_ends_at > Date.now() + threeDays - 60000, 'fresh grace window');
  db.prepare('UPDATE entitlements SET grace_ends_at = ?, checked_at = ? WHERE account_id = ?')
    .run(Date.now() - 1000, stale, acc4);
  await revalidateOnce(db, whop);
  assert.strictEqual(
    db.prepare('SELECT status FROM entitlements WHERE account_id = ?').get(acc4).status,
    'suspended',
    'expired grace swept to suspended'
  );
  const acc5 = Number(db.prepare(
    "INSERT INTO accounts (whop_user_id, created_at) VALUES ('user-5', ?)"
  ).run(Date.now()).lastInsertRowid);
  db.prepare(
    "INSERT INTO entitlements (account_id, status, renews_at, checked_at) VALUES (?, 'active', 111, ?)"
  ).run(acc5, stale);
  const renews5 = Date.now() + 20 * 86400000;
  fakeWhop.setMembership('user-5', { valid: true, renewsAtMs: renews5 });
  await revalidateOnce(db, whop);
  const ent5 = db.prepare('SELECT * FROM entitlements WHERE account_id = ?').get(acc5);
  assert.strictEqual(ent5.status, 'active', 'valid membership stays active');
  assert.ok(Math.abs(ent5.renews_at - renews5) < 1000, 'renews_at refreshed from Whop');
  assert.ok(ent5.checked_at > stale, 'checked_at refreshed');
  ok('revalidateOnce: invalid -> grace -> suspended; valid -> active with renews_at');

  // ---- degraded mode: billing configured, mail NOT configured ----
  const dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-degraded-'));
  const app3 = createApp({ dataDir: dataDir3, whop, mailer: null });
  const listener3 = app3.listen(0, '127.0.0.1');
  await new Promise((r) => listener3.once('listening', r));
  const base3 = `http://127.0.0.1:${listener3.address().port}`;
  const db3 = openDb(dataDir3);
  assert.strictEqual((await fetch(`${base3}/healthz`)).status, 200, 'degraded app boots');
  const portal3 = await fetch(`${base3}/portal`);
  assert.strictEqual(portal3.status, 503, 'portal unavailable without mail');
  const body7 = wentValid('user-7', 'user-7@example.com', renewsSec);
  const wh7 = await postWebhook(body7, signWebhook(body7, whopConfig.webhookSecret), base3);
  assert.strictEqual(wh7.status, 200, 'webhook still processed');
  const acc7 = db3.prepare("SELECT id FROM accounts WHERE whop_user_id = 'user-7'").get();
  assert.strictEqual(
    db3.prepare('SELECT status FROM entitlements WHERE account_id = ?').get(acc7.id).status,
    'active',
    'entitlement created in degraded mode'
  );
  assert.strictEqual(
    db3.prepare('SELECT reason FROM mail_failures WHERE account_id = ?').get(acc7.id).reason,
    'mail_not_configured',
    'undelivered token recorded'
  );
  ok('degraded mode: boots, webhook creates entitlements, failure recorded');

  // ---- nothing configured: maintenance portal, webhook 503 ----
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-whop-off-'));
  const app2 = createApp({ dataDir: dataDir2 });
  const listener2 = app2.listen(0, '127.0.0.1');
  await new Promise((r) => listener2.once('listening', r));
  const base2 = `http://127.0.0.1:${listener2.address().port}`;
  const portalOff = await fetch(`${base2}/portal`);
  assert.strictEqual(portalOff.status, 503, 'portal reports unavailability');
  assert.ok(/temporarily unavailable/.test(await portalOff.text()), 'maintenance message shown');
  const whOff = await postWebhook(body1, signWebhook(body1, 'whatever'), base2);
  assert.strictEqual(whOff.status, 503, 'webhook endpoint disabled without a secret');
  assert.strictEqual((await fetch(`${base2}/healthz`)).status, 200, 'core service unaffected');
  ok('unconfigured mode: portal maintenance, webhook 503, healthz fine');

  // ---- createMailer unit test: nodemailer transport options + content ----
  const transports = [];
  const fakeCreateTransport = (opts) => {
    const t = {
      opts,
      messages: [],
      sendMail(m) {
        if (m.to === 'fail@example.com') return Promise.reject(new Error('SMTP 535 auth failed'));
        t.messages.push(m);
        return Promise.resolve({ messageId: 'fake-1' });
      },
      verify: () => Promise.resolve(true),
    };
    transports.push(t);
    return t;
  };
  const mailOpts = {
    host: 'smtp.gmail.com', user: 'sync@onetimesuite.com', pass: 'app-password',
    from: 'Boardly <sync@onetimesuite.com>', createTransport: fakeCreateTransport,
  };
  const m465 = createMailer({ ...mailOpts, port: 465 });
  assert.strictEqual(transports[0].opts.secure, true, 'port 465 -> implicit TLS');
  assert.strictEqual(transports[0].opts.requireTLS, false, '465 needs no STARTTLS flag');
  assert.strictEqual(transports[0].opts.connectionTimeout, 10000, '10s timeout preserved');
  assert.deepStrictEqual(transports[0].opts.auth, { user: 'sync@onetimesuite.com', pass: 'app-password' });
  const m587 = createMailer({ ...mailOpts, port: 587 });
  assert.strictEqual(transports[1].opts.secure, false, 'port 587 -> STARTTLS');
  assert.strictEqual(transports[1].opts.requireTLS, true, '587 requires TLS upgrade');
  const testToken = 'bsk_' + 'a'.repeat(64);
  await m465.sendTokenEmail('buyer@example.com', testToken);
  const sentMsg = transports[0].messages[0];
  assert.strictEqual(sentMsg.subject, 'Your Boardly Cloud Sync token');
  assert.strictEqual(sentMsg.from, 'Boardly <sync@onetimesuite.com>');
  assert.strictEqual(sentMsg.to, 'buyer@example.com');
  assert.ok(sentMsg.text.includes(testToken) && sentMsg.html.includes(testToken), 'token in both bodies');
  assert.ok(sentMsg.text.includes('Settings'), 'plain body explains where to paste');
  assert.ok(sentMsg.text.includes('https://boardly.onetimesuite.com'), 'app link included');
  await assert.rejects(
    () => m465.sendTokenEmail('fail@example.com', testToken),
    /SMTP 535/,
    'sendTokenEmail rejects on SMTP failure'
  );
  ok('createMailer: 465 secure / 587 requireTLS, email content, throw-on-failure');

  listener.close();
  listener2.close();
  listener3.close();
  fakeWhop.close();
  console.log(`\nAll ${pass} whop tests passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
