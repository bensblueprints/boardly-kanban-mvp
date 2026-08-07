/* mailer.js — optional email for Boardly: due-date reminders and a weekly
 * activity digest, sent through Resend.
 *
 * Positioning matters here. Boardly is a one-time purchase and stays fully
 * functional with no email configured — nothing is held back. Email is a
 * *connected* feature: it needs a machine that is awake when you are not, so
 * it belongs to the hosted tier. Self-hosters get it too, for free, by pasting
 * in their own Resend key. You are never paying us for the software; you are
 * optionally paying us to run the box.
 *
 * Follows the same shape as coach.js: a JSON settings file in dataDir, a
 * probe() to test the config, and plain fetch with no new dependency.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: false,
  apiKey: '',                    // Resend API key
  from: 'boardly@localhost',
  to: '',                        // where reminders go
  dueReminders: true,
  dueLookaheadDays: 2,           // "due soon" window
  weeklyDigest: true,
  digestWeekday: 1,              // 0 = Sunday
  sendHour: 8,                   // local hour for the daily check
  siteUrl: '',                   // e.g. https://boards.example.com — used for card links
};

const settingsPath = (dataDir) => path.join(dataDir, 'mail.json');

function readSettings(dataDir) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8')); } catch { saved = {}; }
  return { ...DEFAULTS, ...saved };
}

function writeSettings(dataDir, patch) {
  const next = { ...readSettings(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath(dataDir), JSON.stringify(next, null, 2));
  return next;
}

/* ---------------- sending --------------------------------------------------- */

async function sendMail(settings, { subject, html, text }) {
  if (!settings.apiKey) throw new Error('No Resend API key configured');
  if (!settings.to) throw new Error('No recipient address configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: settings.from || DEFAULTS.from,
      to: [settings.to],
      subject,
      html,
      text
    }),
    signal: AbortSignal.timeout(15000)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return {}; }
}

async function probe(settings) {
  try {
    await sendMail(settings, {
      subject: 'Boardly email is working',
      html: shell('Boardly email is working', [
        '<p style="margin:0 0 16px;">If you are reading this, reminders and digests will reach you.</p>'
      ].join('')),
      text: 'Boardly email is working. Reminders and digests will reach you.'
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------------- queries --------------------------------------------------- */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/* Cards with a due date that is overdue or lands inside the lookahead window.
   Archived cards and cards on archived lists are excluded — a reminder about
   something you already filed away is noise, and noise gets email muted.

   `db` is the async store from server/data — the queries use its portable
   dialect ({{date(x)}} truncates a TEXT timestamp on both engines). ownerId
   scopes the read to one user's boards; null means all boards (the hourly
   scheduler on a shared server). */
async function dueCards(db, lookaheadDays, ownerId = null) {
  const horizon = addDays(today(), lookaheadDays);
  const scope = ownerId == null ? '' : 'AND b.owner_id = ?';
  const params = ownerId == null ? [horizon] : [horizon, ownerId];
  return db.all(`
    SELECT c.id, c.title, c.due_date, l.name AS list_name, b.name AS board_name, b.id AS board_id
    FROM cards c
    JOIN lists  l ON l.id = c.list_id
    JOIN boards b ON b.id = l.board_id
    WHERE c.archived = 0
      AND l.archived = 0
      AND c.due_date IS NOT NULL
      AND {{date(c.due_date)}} <= ?
      ${scope}
    ORDER BY {{date(c.due_date)}} ASC, b.name, l.name
  `, params);
}

/* Timestamps are UTC TEXT that sorts lexicographically, so the window is a
   plain comparison against {{now-Nd}}. */
async function recentActivity(db, days, ownerId = null) {
  const shift = -Math.trunc(Number(days) || 0);
  const mod = (shift >= 0 ? '+' : '') + shift;
  const scope = ownerId == null ? '' : 'AND b.owner_id = ?';
  const params = ownerId == null ? [] : [ownerId];
  return db.all(`
    SELECT a.action, a.detail, a.created_at, b.name AS board_name
    FROM activity a
    JOIN boards b ON b.id = a.board_id
    WHERE a.created_at >= {{now${mod}d}}
      ${scope}
    ORDER BY a.id DESC
    LIMIT 200
  `, params);
}

/* ---------------- rendering -------------------------------------------------- */

function shell(title, inner) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f4f5f2;font-family:ui-monospace,Menlo,monospace;color:#17191d;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1.5px solid #17191d;border-radius:12px;padding:28px;">
    <p style="margin:0 0 4px;font-size:13px;color:#85888f;">Boardly</p>
    <h1 style="margin:0 0 18px;font-size:20px;">${esc(title)}</h1>
${inner}
    <p style="margin:24px 0 0;font-size:12px;color:#85888f;">You own this copy of Boardly. Turn these off any time in Settings &rarr; Email.</p>
  </div>
</body></html>`;
}

function renderDue(cards, settings) {
  const now = today();
  const overdue = cards.filter((c) => c.due_date.slice(0, 10) < now);
  const soon = cards.filter((c) => c.due_date.slice(0, 10) >= now);

  const link = (c) => settings.siteUrl
    ? `<a href="${esc(settings.siteUrl.replace(/\/+$/, ''))}/?board=${c.board_id}&card=${c.id}" style="color:#e8420c;text-decoration:none;">${esc(c.title)}</a>`
    : esc(c.title);

  const row = (c) => `      <li style="margin:0 0 8px;line-height:1.5;">${link(c)}<br>
        <span style="font-size:12px;color:#85888f;">${esc(c.board_name)} &rsaquo; ${esc(c.list_name)} &middot; due ${esc(c.due_date.slice(0, 10))}</span></li>`;

  const parts = [];
  if (overdue.length) {
    parts.push(`    <p style="margin:0 0 8px;font-weight:700;color:#c02b0a;">Overdue (${overdue.length})</p>
    <ul style="margin:0 0 20px;padding-left:20px;font-size:15px;">\n${overdue.map(row).join('\n')}\n    </ul>`);
  }
  if (soon.length) {
    parts.push(`    <p style="margin:0 0 8px;font-weight:700;">Due soon (${soon.length})</p>
    <ul style="margin:0 0 8px;padding-left:20px;font-size:15px;">\n${soon.map(row).join('\n')}\n    </ul>`);
  }

  const subject = overdue.length
    ? `${overdue.length} overdue${soon.length ? `, ${soon.length} due soon` : ''}`
    : `${soon.length} card${soon.length === 1 ? '' : 's'} due soon`;

  const text = cards
    .map((c) => `- ${c.title} (${c.board_name} > ${c.list_name}) due ${c.due_date.slice(0, 10)}`)
    .join('\n');

  return { subject, html: shell(subject, parts.join('\n')), text };
}

function renderDigest(rows, days) {
  const byBoard = new Map();
  for (const r of rows) {
    if (!byBoard.has(r.board_name)) byBoard.set(r.board_name, []);
    byBoard.get(r.board_name).push(r);
  }

  const blocks = [...byBoard.entries()].map(([board, items]) => {
    const counts = items.reduce((acc, i) => { acc[i.action] = (acc[i.action] || 0) + 1; return acc; }, {});
    const summary = Object.entries(counts).map(([a, n]) => `${n} ${a}`).join(' &middot; ');
    return `    <p style="margin:0 0 6px;font-weight:700;">${esc(board)}</p>
    <p style="margin:0 0 16px;font-size:13px;color:#85888f;">${summary}</p>`;
  });

  const subject = rows.length
    ? `Last ${days} days: ${rows.length} change${rows.length === 1 ? '' : 's'} across ${byBoard.size} board${byBoard.size === 1 ? '' : 's'}`
    : `Quiet week on your boards`;

  const inner = rows.length
    ? blocks.join('\n')
    : '    <p style="margin:0;">No changes in the last week. Sometimes that is the correct amount of work.</p>';

  return {
    subject,
    html: shell(subject, inner),
    text: rows.length
      ? [...byBoard.entries()].map(([b, i]) => `${b}: ${i.length} changes`).join('\n')
      : 'No changes in the last week.'
  };
}

/* ---------------- the daily check ------------------------------------------- */

/* Called once an hour by the caller; only acts inside the configured hour, and
   records what it last sent so a restart cannot double-send in the same day. */
async function runOnce(db, dataDir, { force = false, ownerId = null } = {}) {
  const s = readSettings(dataDir);
  if (!s.enabled && !force) return { skipped: 'disabled' };
  if (!s.apiKey || !s.to) return { skipped: 'not configured' };

  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const state = readSettings(dataDir);
  const sent = [];

  if (!force && now.getHours() < Number(s.sendHour || 0)) return { skipped: 'too early' };

  if (s.dueReminders && (force || state._lastDue !== stamp)) {
    const cards = await dueCards(db, Number(s.dueLookaheadDays) || 0, ownerId);
    if (cards.length) {
      await sendMail(s, renderDue(cards, s));
      sent.push(`due:${cards.length}`);
    }
    if (!force) writeSettings(dataDir, { _lastDue: stamp });
  }

  if (s.weeklyDigest && (force || (now.getDay() === Number(s.digestWeekday) && state._lastDigest !== stamp))) {
    const rows = await recentActivity(db, 7, ownerId);
    await sendMail(s, renderDigest(rows, 7));
    sent.push(`digest:${rows.length}`);
    if (!force) writeSettings(dataDir, { _lastDigest: stamp });
  }

  return { sent };
}

module.exports = {
  DEFAULTS, readSettings, writeSettings, probe, sendMail,
  dueCards, recentActivity, renderDue, renderDigest, runOnce
};
