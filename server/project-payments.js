const crypto = require('node:crypto');
const express = require('express');
const { safeText } = require('./agent-activity');

const currencies = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, SGD: 2, THB: 2, MYR: 2, INR: 2, VND: 0, JPY: 0, KRW: 0 };
const MAX_AMOUNT = 1000000000000;
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const amount = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT;
function cardNumber(value) {
  if (typeof value !== 'string' || !/^[\d -]{13,30}$/.test(value)) fail('Enter a valid card number');
  const number = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(number) || /^(\d)\1+$/.test(number)) fail('Enter a valid card number');
  let sum = 0;
  for (let i = number.length - 1, doubled = false; i >= 0; i--, doubled = !doubled) { let n = Number(number[i]); if (doubled && (n *= 2) > 9) n -= 9; sum += n; }
  if (sum % 10) fail('Check the card number');
  return number;
}
function brand(number) { return /^4/.test(number) ? 'Visa' : /^3[47]/.test(number) ? 'Amex' : /^(5[1-5]|2[2-7])/.test(number) ? 'Mastercard' : /^6(?:011|5|4)/.test(number) ? 'Discover' : 'Card'; }
function field(value, name, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value) || (required && !value.trim())) fail(`Enter a valid ${name}`);
  return value.trim();
}
function merchantOrigin(value) {
  let url; try { url = new URL(value); } catch { fail('Enter an HTTPS checkout URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('Enter an HTTPS checkout URL without credentials');
  return url.origin;
}

function createProjectPayments({ db, key, namespace }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_payment_settings (
    board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
    currency TEXT NOT NULL, budget_minor INTEGER NOT NULL CHECK(budget_minor>=0),
    allow_agent INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_payment_cards (
    id TEXT PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    label TEXT NOT NULL, brand TEXT NOT NULL, last4 TEXT NOT NULL,
    exp_month INTEGER NOT NULL, exp_year INTEGER NOT NULL, encrypted TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_purchases (
    id TEXT PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    card_id TEXT REFERENCES project_payment_cards(id) ON DELETE SET NULL,
    card_last4 TEXT NOT NULL, job_id TEXT NOT NULL, request_key TEXT NOT NULL,
    merchant_origin TEXT NOT NULL, description TEXT NOT NULL,
    amount_minor INTEGER NOT NULL, actual_minor INTEGER, currency TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved','paid','released','uncertain')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(board_id,job_id,request_key)
  );
  CREATE INDEX IF NOT EXISTS project_purchases_board ON project_purchases(board_id,status);`);
  const aad = (boardId, id) => Buffer.from(JSON.stringify(['project-payment-card', namespace, Number(boardId), id]));
  const encode = (boardId, id, data) => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(boardId, id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
  };
  const decode = row => {
    const bytes = Buffer.from(row.encrypted, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(aad(row.board_id, row.id)); decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
  };
  const getCard = (boardId, id) => db.prepare('SELECT * FROM project_payment_cards WHERE board_id=? AND id=?').get(boardId, id);
  const cardList = boardId => db.prepare('SELECT id,label,brand,last4,exp_month,exp_year,enabled,created_at,updated_at FROM project_payment_cards WHERE board_id=? ORDER BY created_at').all(boardId);
  function summary(boardId) {
    const settings = db.prepare('SELECT currency,budget_minor,allow_agent,updated_at FROM project_payment_settings WHERE board_id=?').get(boardId) || { currency: 'USD', budget_minor: 0, allow_agent: 0 };
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='paid' THEN actual_minor ELSE 0 END),0) spent_minor,
      COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') THEN amount_minor ELSE 0 END),0) reserved_minor FROM project_purchases WHERE board_id=?`).get(boardId);
    return { ...settings, ...totals, remaining_minor: settings.budget_minor - totals.spent_minor - totals.reserved_minor, cards: cardList(boardId), limit_type: 'Boardly lifetime budget; not a bank card limit' };
  }
  function redact(boardId, text) {
    // Also recognize spaced/dashed PANs if a checkout script accidentally prints one.
    const numbers = db.prepare('SELECT * FROM project_payment_cards WHERE board_id=?').all(boardId).map(r => decode(r).number);
    let cleaned = String(text || '');
    for (const number of numbers) cleaned = cleaned.replace(new RegExp(number.split('').join('[ -]*'), 'g'), '[REDACTED CARD]');
    return cleaned;
  }
  const clean = (boardId, text) => safeText(redact(boardId, text));
  function saveSettings(boardId, data) {
    if (!Object.hasOwn(currencies, data.currency) || !amount(data.budget_minor) || typeof data.allow_agent !== 'boolean') fail('Choose a currency, a valid budget and agent access setting');
    return db.transaction(() => {
      const current = summary(boardId);
      if (current.currency !== data.currency && db.prepare("SELECT id FROM project_purchases WHERE board_id=? AND status!='released'").get(boardId)) fail('Currency cannot change while purchase history or budget holds exist', 409);
      if (data.budget_minor < current.spent_minor + current.reserved_minor) fail('The budget cannot be below recorded spending and current holds', 409);
      db.prepare('INSERT INTO project_payment_settings VALUES (?,?,?,?,?) ON CONFLICT(board_id) DO UPDATE SET currency=excluded.currency,budget_minor=excluded.budget_minor,allow_agent=excluded.allow_agent,updated_at=excluded.updated_at').run(boardId, data.currency, data.budget_minor, Number(data.allow_agent), Date.now());
      return summary(boardId);
    }).immediate();
  }
  function saveCard(boardId, data) {
    // Deliberately accept only the wallet fields below, never CVV/PIN/track data.
    if (Object.keys(data).some(k => !['label','number','cardholder','billing','exp_month','exp_year'].includes(k))) fail('Unsupported card field. Security codes and PINs are not stored.');
    const number = cardNumber(data.number), label = safeText(field(data.label, 'card label', 80, true)), cardholder = field(data.cardholder, 'cardholder name', 120, true);
    const now = new Date();
    if (!Number.isInteger(data.exp_month) || data.exp_month < 1 || data.exp_month > 12 || !Number.isInteger(data.exp_year) || data.exp_year > now.getUTCFullYear() + 25 || data.exp_year * 12 + data.exp_month < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) fail('Enter a valid card expiry');
    const billing = {}, address = data.billing || {};
    for (const name of ['line1','line2','city','region','postal_code','country']) billing[name] = field(address[name], `billing ${name.replace('_',' ')}`, name === 'country' ? 2 : 180, ['line1','city','country'].includes(name));
    billing.country = billing.country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(billing.country)) fail('Use a two-letter billing country code');
    if (cardList(boardId).length >= 10) fail('A project can have up to 10 saved cards');
    const id = crypto.randomUUID(), encrypted = encode(boardId, id, { number, cardholder, billing });
    db.prepare('INSERT INTO project_payment_cards VALUES (?,?,?,?,?,?,?,?,1,?,?)').run(id, boardId, label, brand(number), number.slice(-4), data.exp_month, data.exp_year, encrypted, Date.now(), Date.now());
    return cardList(boardId).find(c => c.id === id);
  }
  function reserve(boardId, jobId, data) {
    if (!amount(data.amount_minor) || data.amount_minor === 0) fail('Supply the final checkout total in minor currency units');
    if (typeof data.request_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(data.request_key)) fail('Supply a stable checkout request key');
    const merchant = merchantOrigin(data.merchant_url), description = clean(boardId, field(data.description, 'purchase description', 500, true));
    if (clean(boardId, data.request_key) !== data.request_key || clean(boardId, merchant) !== merchant) fail('Do not include card numbers or credentials in checkout references or URLs');
    return db.transaction(() => {
      const settings = summary(boardId), card = getCard(boardId, data.card_id);
      if (!settings.allow_agent) fail('Agent card access is paused for this project', 403);
      if (!card || !card.enabled) fail('An enabled card assigned to this project is required', 403);
      const now = new Date();
      if (card.exp_year * 12 + card.exp_month < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) fail('This card has expired');
      if (data.currency !== settings.currency) fail('Checkout currency must match the project budget');
      const previous = db.prepare('SELECT * FROM project_purchases WHERE board_id=? AND job_id=? AND request_key=?').get(boardId, jobId, data.request_key);
      if (previous) {
        if (previous.card_id !== card.id || previous.amount_minor !== data.amount_minor || previous.merchant_origin !== merchant || previous.description !== description || previous.currency !== data.currency) fail('This request key belongs to a different checkout', 409);
        if (previous.status !== 'reserved') fail('This checkout is already closed or needs review. Do not retry the purchase.', 409);
        return { purchase: previous, card: { ...decode(card), exp_month: card.exp_month, exp_year: card.exp_year } };
      }
      if (data.amount_minor > settings.remaining_minor) fail('Checkout exceeds the remaining project budget', 409);
      const id = crypto.randomUUID(), time = Date.now();
      db.prepare("INSERT INTO project_purchases VALUES (?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)").run(id, boardId, card.id, card.last4, jobId, data.request_key, merchant, description, data.amount_minor, null, data.currency, time, time);
      return { purchase: db.prepare('SELECT * FROM project_purchases WHERE id=?').get(id), card: { ...decode(card), exp_month: card.exp_month, exp_year: card.exp_year } };
    }).immediate();
  }
  function finish(boardId, id, data, jobId = null) {
    return db.transaction(() => {
      const purchase = db.prepare('SELECT * FROM project_purchases WHERE id=? AND board_id=?').get(id, boardId);
      if (!purchase || (jobId !== null && purchase.job_id !== jobId)) fail('Purchase request not found', 404);
      if (!['paid','released','uncertain'].includes(data.status)) fail('Choose a valid checkout outcome');
      const actual = data.status === 'paid' ? data.actual_minor : null;
      if (data.status === 'paid' && (!amount(actual) || actual === 0)) fail('Enter the actual amount paid');
      if (purchase.status === data.status && purchase.actual_minor === actual) return purchase;
      if (!['reserved','uncertain'].includes(purchase.status) || (jobId !== null && purchase.status === 'uncertain')) fail('This checkout is already closed or needs owner review', 409);
      // Record an actual overcharge honestly, even if it exceeds the reservation.
      db.prepare('UPDATE project_purchases SET status=?,actual_minor=?,updated_at=? WHERE id=?').run(data.status, actual, Date.now(), id);
      return db.prepare('SELECT * FROM project_purchases WHERE id=?').get(id);
    }).immediate();
  }
  const router = express.Router(), body = express.json({ limit: '16kb' });
  const route = fn => (req, res, next) => { try { fn(req, res); } catch (e) { if (e.status) res.status(e.status).json({ error: e.message }); else next(e); } };
  router.use('/api/boards/:boardId/payments', (req, res, next) => db.prepare('SELECT id FROM boards WHERE id=?').get(req.params.boardId) ? next() : res.status(404).json({ error: 'Project not found' }));
  router.get('/api/boards/:boardId/payments', route((req, res) => res.json({ ...summary(req.params.boardId), currencies,
    purchases: db.prepare('SELECT * FROM project_purchases WHERE board_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.boardId) })));
  router.put('/api/boards/:boardId/payments', body, route((req, res) => res.json(saveSettings(Number(req.params.boardId), req.body || {}))));
  router.post('/api/boards/:boardId/payments/cards', body, route((req, res) => res.status(201).json(saveCard(Number(req.params.boardId), req.body || {}))));
  router.get('/api/boards/:boardId/payments/cards/:id/billing', route((req, res) => {
    const row = getCard(req.params.boardId, req.params.id); if (!row) fail('Card not found', 404);
    const { number, ...billing } = decode(row); res.json(billing);
  }));
  router.patch('/api/boards/:boardId/payments/cards/:id', body, route((req, res) => {
    if (typeof req.body?.enabled !== 'boolean') fail('Choose whether this card is enabled');
    if (!db.prepare('UPDATE project_payment_cards SET enabled=?,updated_at=? WHERE board_id=? AND id=?').run(Number(req.body.enabled), Date.now(), req.params.boardId, req.params.id).changes) fail('Card not found', 404);
    res.json({ ok: true });
  }));
  router.delete('/api/boards/:boardId/payments/cards/:id', route((req, res) => {
    if (db.prepare("SELECT id FROM project_purchases WHERE board_id=? AND card_id=? AND status IN ('reserved','uncertain')").get(req.params.boardId, req.params.id)) fail('Resolve open checkout holds before removing this card. You can pause it now.', 409);
    if (!db.prepare('DELETE FROM project_payment_cards WHERE board_id=? AND id=?').run(req.params.boardId, req.params.id).changes) fail('Card not found', 404);
    res.json({ ok: true });
  }));
  router.post('/api/boards/:boardId/payments/purchases/:id/resolve', body, route((req, res) => res.json(finish(Number(req.params.boardId), req.params.id, req.body || {}))));
  return { router, summary, reserve, finish, redact };
}
module.exports = { createProjectPayments, cardNumber, currencies };
