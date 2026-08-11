// Boardly sync-server: multi-tenant store for opaque entity payloads and
// attachment bytes. Bearer-token auth + entitlement gate on /api/*.
// There is deliberately no endpoint that renders or aggregates board content.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { openDb, blobPath } = require('./db');
const whoplib = require('./whop');
const { createMailer } = require('./mailer');

// Same whitelist as the client tracker (server/sync/track.js).
const TRACKED_TABLES = [
  'boards',
  'lists',
  'cards',
  'labels',
  'card_labels',
  'checklists',
  'checklist_items',
  'comments',
  'attachments',
];

const MAX_PUSH_CHANGES = 1000;
const SUBSCRIPTION_INACTIVE = {
  error: 'subscription_inactive',
  message: 'Subscription inactive — sync paused, your local data is safe',
};

// Attachment uuids become file paths, so keep them strictly path-safe.
const UUID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// POST /portal/request-token rate limit: 5 requests per 10 minutes per IP
// (in-memory — the server runs as a single instance).
const PORTAL_RATE_LIMIT_MAX = 5;
const PORTAL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const maxAttachmentMb = Number(opts.maxAttachmentMb || process.env.MAX_ATTACHMENT_MB || 100);
  const devKey = opts.devBootstrapKey || process.env.DEV_BOOTSTRAP_KEY || null;
  // Whop billing: opts.whop / opts.mailer inject pre-built clients (tests);
  // otherwise build from env. whop === null means billing is not configured
  // (webhook 503s, portal shows maintenance). mailer === null with billing
  // configured is the documented degraded mode: entitlements are still
  // maintained, tokens are only retrievable via the dev bootstrap.
  const whopConfig = opts.whop ? opts.whop.config : whoplib.envConfig(process.env);
  const whop = opts.whop !== undefined
    ? opts.whop
    : (whoplib.billingEnabled(whopConfig) ? whoplib.createWhopClient(whopConfig) : null);
  const mailer = opts.mailer !== undefined
    ? opts.mailer
    : (whoplib.mailEnabled(whopConfig)
      ? createMailer({
        host: whopConfig.smtpHost,
        port: whopConfig.smtpPort,
        user: whopConfig.smtpUser,
        pass: whopConfig.smtpPass,
        from: whopConfig.mailFrom || whopConfig.smtpUser,
      })
      : null);
  if (whop && !mailer) {
    console.error('[billing] mail not configured — token emails disabled (degraded mode)');
  }
  if (mailer && typeof mailer.verify === 'function') {
    // Boot-time transport check, for logs only — never blocks startup.
    mailer.verify()
      .then(() => console.log('[mail] SMTP transport verified'))
      .catch((err) => console.error(`[mail] SMTP transport check failed: ${err.message}`));
  }

  const db = openDb(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  // The webhook route needs the exact raw body for HMAC verification, so it
  // must be mounted BEFORE express.json (same reason attachments use raw).
  app.post('/webhooks/whop', express.raw({ type: '*/*', limit: '1mb' }), handleWhopWebhook);
  app.use(express.json({ limit: '25mb' }));

  const q = {
    token: db.prepare('SELECT account_id FROM tokens WHERE token_hash = ? AND revoked = 0'),
    entitlement: db.prepare('SELECT * FROM entitlements WHERE account_id = ?'),
    entity: db.prepare(
      'SELECT * FROM entities WHERE account_id = ? AND table_name = ? AND uuid = ?'
    ),
    bumpSeq: db.prepare(
      `INSERT INTO account_seq (account_id, seq) VALUES (?, 1)
       ON CONFLICT(account_id) DO UPDATE SET seq = seq + 1`
    ),
    seq: db.prepare('SELECT seq FROM account_seq WHERE account_id = ?'),
    upsertEntity: db.prepare(
      `INSERT INTO entities (account_id, table_name, uuid, payload, updated_at, deleted, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, table_name, uuid) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted,
         seq = excluded.seq`
    ),
    attachment: db.prepare('SELECT * FROM attachments WHERE account_id = ? AND uuid = ?'),
  };

  function nextSeq(accountId) {
    q.bumpSeq.run(accountId);
    return q.seq.get(accountId).seq;
  }

  // ---- auth + entitlement gate for /api/* ----
  function requireAuth(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'unauthorized' });
    const tok = q.token.get(sha256(m[1]));
    if (!tok) return res.status(401).json({ error: 'unauthorized' });
    let ent = q.entitlement.get(tok.account_id);
    const now = Date.now();
    // Lazy grace-expiry sweep: nothing else flips expired grace rows to
    // suspended, so do it on read and persist.
    if (ent && ent.status === 'grace' && ent.grace_ends_at && ent.grace_ends_at <= now) {
      db.prepare("UPDATE entitlements SET status = 'suspended' WHERE account_id = ?")
        .run(tok.account_id);
      ent = { ...ent, status: 'suspended' };
    }
    const active = !!ent && (
      ent.status === 'active' ||
      (ent.status === 'grace' && (!ent.grace_ends_at || ent.grace_ends_at > now))
    );
    if (!active) return res.status(403).json(SUBSCRIPTION_INACTIVE);
    req.accountId = tok.account_id;
    req.entitlement = ent;
    next();
  }

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- dev bootstrap: mint accounts+tokens without Whop (escape hatch for
  // dev/tests and for the mail-not-configured degraded mode; only enabled
  // when DEV_BOOTSTRAP_KEY is set) ----
  if (devKey) {
    app.post('/dev/accounts', (req, res) => {
      const a = Buffer.from(String(req.headers['x-dev-key'] || ''));
      const b = Buffer.from(devKey);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const email = req.body?.email ? String(req.body.email) : null;
      const status = ['active', 'suspended'].includes(req.body?.entitlement)
        ? req.body.entitlement
        : 'active';
      const token = crypto.randomBytes(32).toString('hex');
      const tx = db.transaction(() => {
        const acc = db
          .prepare('INSERT INTO accounts (email, created_at) VALUES (?, ?)')
          .run(email, Date.now());
        db.prepare('INSERT INTO entitlements (account_id, status) VALUES (?, ?)')
          .run(acc.lastInsertRowid, status);
        db.prepare('INSERT INTO tokens (account_id, token_hash, created_at) VALUES (?, ?, ?)')
          .run(acc.lastInsertRowid, sha256(token), Date.now());
        return Number(acc.lastInsertRowid);
      });
      // Plaintext token is returned once; only its hash is stored.
      res.json({ token, accountId: tx() });
    });
  }

  // ---- Whop billing: token-request portal + webhook ----
  // The portal page is the ONLY UI on this server. Tokens are delivered by
  // email, never rendered here — board data is never rendered or aggregated.

  function portalPage(title, inner) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Boardly Cloud Sync</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f5f7;color:#1f2430;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e3e6eb;border-radius:10px;max-width:460px;width:90%;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 10px}
p{font-size:14px;line-height:1.55;color:#4a5160}
.btn{display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;border:0;border-radius:6px;padding:10px 18px;font-size:14px;cursor:pointer}
input[type=email]{width:100%;box-sizing:border-box;border:1px solid #d8dce3;border-radius:6px;padding:10px;font-size:14px;margin:8px 0 12px}
.muted{font-size:12px;color:#8a91a0}
form{margin-top:8px}
</style>
</head>
<body><div class="card">${inner}</div></body>
</html>`;
  }

  const MAINTENANCE_PAGE = portalPage(
    'Boardly Cloud Sync',
    '<h1>Boardly Cloud Sync</h1><p>The account portal is temporarily unavailable. Please try again later.</p>'
  );

  // Neutral response for /portal/request-token — identical whether or not
  // the email matches a membership, so the endpoint can't be used to
  // enumerate subscribers.
  const NEUTRAL_PAGE = portalPage('Check your inbox', `
<h1>Check your inbox</h1>
<p>If a Boardly Cloud Sync membership exists for that email, a token is on its way.</p>
<p class="muted">The token email invalidates any previous tokens.</p>`);

  function upsertAccountByWhopUser(whopUserId, email) {
    const existing = db.prepare('SELECT id FROM accounts WHERE whop_user_id = ?').get(whopUserId);
    if (existing) {
      if (email) db.prepare('UPDATE accounts SET email = ? WHERE id = ?').run(email, existing.id);
      return existing.id;
    }
    return Number(
      db.prepare('INSERT INTO accounts (email, whop_user_id, created_at) VALUES (?, ?, ?)')
        .run(email || null, whopUserId, Date.now()).lastInsertRowid
    );
  }

  function upsertEntitlement(accountId, status, graceEndsAt, renewsAt, checkedAt) {
    db.prepare(
      `INSERT INTO entitlements (account_id, status, grace_ends_at, renews_at, checked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         status = excluded.status,
         grace_ends_at = excluded.grace_ends_at,
         renews_at = excluded.renews_at,
         checked_at = excluded.checked_at`
    ).run(accountId, status, graceEndsAt, renewsAt, checkedAt);
  }

  function mintToken(accountId) {
    // Delivered by email exactly once; only the sha256 hash is stored.
    const token = 'bsk_' + crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO tokens (account_id, token_hash, created_at) VALUES (?, ?, ?)')
      .run(accountId, sha256(token), Date.now());
    return token;
  }

  // Every delivery failure lands here so ops can replay it.
  function recordMailFailure(accountId, email, reason) {
    db.prepare(
      'INSERT INTO mail_failures (account_id, email, reason, created_at) VALUES (?, ?, ?, ?)'
    ).run(accountId || null, email || null, String(reason).slice(0, 300), Date.now());
  }

  // Mint a fresh token (revoking old ones) and email it. Delivery problems
  // are logged + recorded, never thrown to the caller.
  async function deliverToken(accountId, email, { revokeExisting }) {
    if (!email) {
      recordMailFailure(accountId, null, 'no_email_in_payload');
      console.error(`[mail] no buyer email for account ${accountId}; token undeliverable`);
      return;
    }
    if (!mailer) {
      recordMailFailure(accountId, email, 'mail_not_configured');
      console.error(`[mail] mail not configured — token for account ${accountId} not delivered`);
      return;
    }
    let token;
    db.transaction(() => {
      if (revokeExisting) {
        db.prepare('UPDATE tokens SET revoked = 1 WHERE account_id = ?').run(accountId);
      }
      token = mintToken(accountId);
    })();
    try {
      await mailer.sendTokenEmail(email, token);
    } catch (err) {
      recordMailFailure(accountId, email, `send_failed: ${err.message}`);
      console.error(`[mail] token email to account ${accountId} failed: ${err.message}`);
    }
  }

  app.get('/portal', (req, res) => {
    if (!mailer) return res.status(503).send(MAINTENANCE_PAGE);
    const buy = whopConfig.checkoutUrl
      ? `<p class="muted">No membership yet? <a href="${esc(whopConfig.checkoutUrl)}">Get Boardly Cloud Sync — $5/month</a></p>`
      : '';
    res.send(portalPage('Get your sync token', `
<h1>Boardly Cloud Sync</h1>
<p>Enter the email you used at checkout and we'll send your Boardly sync token.</p>
<form method="post" action="/portal/request-token">
<input type="email" name="email" placeholder="you@example.com" required>
<button class="btn" type="submit">Send my token</button>
</form>
<p class="muted">Requesting a token invalidates any previous tokens.</p>
${buy}`));
  });

  // Per-IP rate limiter for the request-token endpoint.
  const portalRequests = new Map(); // ip -> [timestamps]
  function rateLimited(ip) {
    const now = Date.now();
    const hits = (portalRequests.get(ip) || []).filter((t) => now - t < PORTAL_RATE_LIMIT_WINDOW_MS);
    if (hits.length >= PORTAL_RATE_LIMIT_MAX) {
      portalRequests.set(ip, hits);
      return true;
    }
    hits.push(now);
    portalRequests.set(ip, hits);
    return false;
  }

  app.post('/portal/request-token', express.urlencoded({ extended: false }), async (req, res) => {
    if (!mailer) return res.status(503).send(MAINTENANCE_PAGE);
    if (rateLimited(req.ip)) {
      return res.status(429).send(portalPage('Too many requests',
        '<h1>Too many requests</h1><p>Please wait a few minutes and try again.</p>'));
    }
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (email && email.includes('@')) {
        const row = db.prepare(
          `SELECT a.id AS account_id, e.status, e.grace_ends_at
           FROM accounts a JOIN entitlements e ON e.account_id = a.id
           WHERE lower(a.email) = ?`
        ).get(email);
        const now = Date.now();
        const eligible = row && (
          row.status === 'active' ||
          (row.status === 'grace' && (!row.grace_ends_at || row.grace_ends_at > now))
        );
        if (eligible) {
          await deliverToken(row.account_id, email, { revokeExisting: true });
        }
      }
    } catch (err) {
      // Never surface internals — the response is always the neutral page.
      console.error(`[portal] request-token error: ${err.message}`);
    }
    res.send(NEUTRAL_PAGE);
  });

  // ---- Whop webhook: membership lifecycle -> entitlement + token email ----
  let webhookShapeLogged = false;

  async function handleWhopWebhook(req, res) {
    if (!whoplib.webhooksEnabled(whopConfig)) {
      // Whop is not wired up on this deployment; nothing to verify against.
      return res.status(503).json({ error: 'webhooks_not_configured' });
    }
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'raw body required' });
    }
    if (!whoplib.verifyWebhookSignature(req.body, req.headers, whopConfig.webhookSecret)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    let parsed;
    let event;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
      event = whoplib.parseWebhookEvent(parsed);
    } catch (err) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    if (!webhookShapeLogged) {
      // The buyer-email location in the payload isn't documented — log the
      // shape of the first real event so ops can verify the extraction.
      webhookShapeLogged = true;
      console.debug('[webhook] first event payload shape:', JSON.stringify({
        keys: Object.keys(parsed || {}),
        dataKeys: Object.keys((parsed && parsed.data) || {}),
        emailFound: !!event.email,
      }));
    }
    const now = Date.now();
    try {
      if (event.type === 'went_valid' && event.whopUserId) {
        const accountId = upsertAccountByWhopUser(event.whopUserId, event.email);
        upsertEntitlement(accountId, 'active', null, event.renewsAt, now);
        // Whop delivery is at-least-once: if an unrevoked token already
        // exists this is a duplicate — don't mint or email again.
        const hasToken = db
          .prepare('SELECT id FROM tokens WHERE account_id = ? AND revoked = 0')
          .get(accountId);
        if (!hasToken) {
          await deliverToken(accountId, event.email, { revokeExisting: false });
        }
      } else if (event.type === 'went_invalid' && event.whopUserId) {
        // Upsert even for unknown users: Whop does not guarantee delivery
        // order, so a went_invalid can arrive before its went_valid.
        const accountId = upsertAccountByWhopUser(event.whopUserId, event.email);
        upsertEntitlement(
          accountId, 'grace', now + whopConfig.graceDays * 24 * 60 * 60 * 1000, event.renewsAt, now
        );
      }
    } catch (err) {
      console.error(`[webhook] handler error: ${err.message}`);
      return res.status(500).json({ error: 'internal error' });
    }
    // Unknown event types: acknowledged and ignored. Always answer 200
    // quickly — Whop retries deliveries on non-2xx.
    res.status(200).json({ ok: true });
  }

  app.use('/api', requireAuth);

  // ---- sync push: batch of {table, uuid, updated_at, deleted, payload} ----
  app.post('/api/sync/push', (req, res) => {
    const changes = req.body?.changes;
    if (!Array.isArray(changes)) {
      return res.status(400).json({ error: 'changes array required' });
    }
    if (changes.length > MAX_PUSH_CHANGES) {
      return res.status(400).json({ error: `too many changes (max ${MAX_PUSH_CHANGES})` });
    }
    for (const c of changes) {
      if (!c || typeof c !== 'object') {
        return res.status(400).json({ error: 'each change must be an object' });
      }
      if (!TRACKED_TABLES.includes(c.table)) {
        return res.status(400).json({ error: `invalid table: ${String(c.table)}` });
      }
      if (typeof c.uuid !== 'string' || !c.uuid || c.uuid.length > 64) {
        return res.status(400).json({ error: 'uuid must be a string of 1-64 chars' });
      }
      if (!Number.isInteger(c.updated_at)) {
        return res.status(400).json({ error: 'updated_at must be an integer (epoch ms)' });
      }
    }

    let accepted = 0;
    let rejected = 0;
    // One transaction per request: LWW check + seq assignment stay atomic.
    const tx = db.transaction(() => {
      for (const c of changes) {
        const stored = q.entity.get(req.accountId, c.table, c.uuid);
        // Accept only if newer-or-equal; ties go to the incoming write
        // (server is the tie-breaker, so all devices converge).
        if (stored && c.updated_at < stored.updated_at) {
          rejected++;
          continue;
        }
        const deleted = c.deleted ? 1 : 0;
        const payload = deleted
          ? null
          : JSON.stringify(c.payload === undefined ? null : c.payload);
        q.upsertEntity.run(
          req.accountId, c.table, c.uuid, payload, c.updated_at, deleted, nextSeq(req.accountId)
        );
        accepted++;
      }
    });
    tx();

    const row = q.seq.get(req.accountId);
    res.json({ accepted, rejected, maxSeq: row ? row.seq : 0 });
  });

  // ---- sync pull: everything with seq > cursor, ordered by seq ----
  app.get('/api/sync/pull', (req, res) => {
    const cursor = Number.isInteger(Number(req.query.cursor)) && Number(req.query.cursor) > 0
      ? Number(req.query.cursor)
      : 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    // Fetch one extra row to know whether more pages exist.
    const rows = db
      .prepare(
        `SELECT table_name, uuid, updated_at, deleted, payload, seq
         FROM entities WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`
      )
      .all(req.accountId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      changes: page.map((r) => ({
        table: r.table_name,
        uuid: r.uuid,
        updated_at: r.updated_at,
        deleted: !!r.deleted,
        payload: r.payload === null ? null : JSON.parse(r.payload),
        seq: r.seq,
      })),
      cursor: page.length ? page[page.length - 1].seq : cursor,
      hasMore,
    });
  });

  // ---- attachments: bytes are content-addressed by uuid, immutable ----
  app.put(
    '/api/sync/attachments/:uuid',
    express.raw({ type: '*/*', limit: `${maxAttachmentMb}mb` }),
    (req, res) => {
      const uuid = req.params.uuid;
      if (!UUID_RE.test(uuid)) return res.status(400).json({ error: 'invalid uuid' });
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'raw body required' });
      }
      const existing = q.attachment.get(req.accountId, uuid);
      if (existing) return res.json({ ok: true, size: existing.size });
      const file = blobPath(dataDir, req.accountId, uuid);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, req.body);
      db.prepare(
        'INSERT INTO attachments (account_id, uuid, size, mime, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        req.accountId,
        uuid,
        req.body.length,
        String(req.headers['content-type'] || 'application/octet-stream'),
        Date.now()
      );
      res.json({ ok: true, size: req.body.length });
    }
  );

  function findAttachment(req, res) {
    const uuid = req.params.uuid;
    if (!UUID_RE.test(uuid)) return null;
    const row = q.attachment.get(req.accountId, uuid);
    if (!row) return null;
    const file = blobPath(dataDir, req.accountId, uuid);
    if (!fs.existsSync(file)) return null;
    return { row, file };
  }

  // Clients HEAD before uploading to skip bytes the server already has.
  app.head('/api/sync/attachments/:uuid', (req, res) => {
    const found = findAttachment(req, res);
    if (!found) return res.status(404).end();
    res.setHeader('content-type', found.row.mime);
    res.setHeader('content-length', found.row.size);
    res.status(200).end();
  });

  app.get('/api/sync/attachments/:uuid', (req, res) => {
    const found = findAttachment(req, res);
    if (!found) return res.status(404).json({ error: 'not found' });
    res.setHeader('content-type', found.row.mime);
    res.setHeader('content-length', found.row.size);
    fs.createReadStream(found.file).pipe(res);
  });

  // ---- account status for the app's Settings UI ----
  app.get('/api/account/status', (req, res) => {
    res.json({
      active: true,
      status: req.entitlement.status,
      renews_at: req.entitlement.renews_at ?? null,
    });
  });

  // ---- 404 + error handling ----
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload too large' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    if (err) return res.status(500).json({ error: 'internal error' });
    next();
  });

  return app;
}

module.exports = { createApp, TRACKED_TABLES };
