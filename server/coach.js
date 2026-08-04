// Voice coach — talks to a local LLM (Ollama) and a local Whisper server, both
// OpenAI-compatible, so one code path covers Ollama / LM Studio / whisper.cpp.
//
// Everything runs on your own hardware; nothing is sent to a third party. The
// model lives on another machine on the LAN, so the endpoints are configurable
// rather than hardcoded to localhost.
//
// Requests are proxied through the Boardly server (not fetched from the
// renderer) so the config lives in one place and there's no CORS dance.

const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  // Ollama binds localhost by default — on the GPU box it needs
  // OLLAMA_HOST=0.0.0.0 before another machine can reach it.
  chatUrl: 'http://127.0.0.1:11434/v1',
  chatModel: 'qwen2.5:14b-instruct-q4_K_M',
  sttUrl: '',
  sttModel: 'whisper-1',
  apiKey: '',
  enabled: false
};

function settingsPath(dataDir) {
  return path.join(dataDir, 'coach.json');
}

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

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

// Node's fetch throws a bare "fetch failed" and buries the real reason in
// err.cause, which is useless when you're trying to work out why a box on the
// other end of a VPN isn't answering. Turn it into something actionable.
function describeFetchError(err, url) {
  let host = url;
  try { const u = new URL(url); host = `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; } catch {}
  const cause = err?.cause || {};
  const code = cause.code || err?.code;

  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${host}. The machine is reachable but refused the connection — ` +
             `either the server isn't running, or it's bound to localhost only. ` +
             `For Ollama, start it with OLLAMA_HOST=0.0.0.0 ollama serve; for vLLM add --host 0.0.0.0.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Can't resolve the hostname in ${host}. Use the Tailscale IP (e.g. 100.x.y.z) if MagicDNS isn't set up.`;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host} didn't respond. The host looks unreachable — check it's awake and on the same Tailscale network.`;
    case 'ECONNRESET':
      return `${host} dropped the connection mid-request. If the model was still loading, give it a moment and retry.`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return `TLS certificate problem talking to ${host}. Use http:// for a local server rather than https://.`;
    default:
      break;
  }
  if (err?.name === 'TimeoutError') {
    return `${host} timed out. If the model is large it may still be loading — retry in a few seconds.`;
  }
  const detail = cause.message || err?.message || 'unknown error';
  return `Could not reach ${host} — ${detail}`;
}

// ---- board context -------------------------------------------------------

// Compact snapshot of what's outstanding. Sent to the model as the grounding
// facts, kept small enough that a 14B model on 16GB doesn't lose the plot.
function buildContext(db, { boardId, limit = 60 } = {}) {
  const boards = boardId
    ? [db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId)].filter(Boolean)
    : db.prepare('SELECT * FROM boards ORDER BY starred DESC, id').all();

  const out = [];
  for (const b of boards) {
    const lists = db.prepare('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY position, id').all(b.id);
    const cards = [];
    for (const l of lists) {
      const rows = db.prepare('SELECT * FROM cards WHERE list_id = ? AND archived = 0 ORDER BY position, id').all(l.id);
      for (const c of rows) {
        const items = db.prepare(
          `SELECT ci.id, ci.text, ci.done FROM checklist_items ci
           JOIN checklists cl ON cl.id = ci.checklist_id
           WHERE cl.card_id = ? ORDER BY ci.id`
        ).all(c.id);
        const labels = db.prepare(
          `SELECT lb.name FROM labels lb JOIN card_labels cl ON cl.label_id = lb.id
           WHERE cl.card_id = ?`
        ).all(c.id).map((x) => x.name);
        const open = items.filter((i) => !i.done);
        // Finished cards are noise for a "what's next" question.
        if (items.length && !open.length) continue;
        cards.push({
          card_id: c.id,
          title: c.title,
          list: l.name,
          labels,
          done_count: items.length - open.length,
          total_count: items.length,
          open_steps: open.map((i) => i.text)
        });
      }
    }
    out.push({ board_id: b.id, board: b.name, description: b.description || '', cards });
  }

  // Prefer the most nearly-finished cards: they're the cheapest wins.
  for (const b of out) {
    b.cards.sort((x, y) => (y.done_count - x.done_count) || (x.open_steps.length - y.open_steps.length));
    b.truncated = b.cards.length > limit;
    b.cards = b.cards.slice(0, limit);
  }
  return out;
}

// Which card to work on is decided in code, not by the model. Asking a local
// model to both choose from 60 cards AND write the plan makes it pattern-match
// the input (echoing the checklist back, and occasionally inventing a card name
// that isn't on the board). Picking here removes that whole class of error and
// leaves the model the one job it's actually good at: turning a terse checklist
// line into concrete actions.
function pickCard(context) {
  const candidates = context.flatMap((b) =>
    b.cards.map((c) => ({ ...c, board_id: b.board_id, board: b.board })));
  if (!candidates.length) return null;
  // buildContext already sorts most-nearly-done first; among equals prefer the
  // one with fewest remaining steps, i.e. the cheapest thing to finish.
  return candidates[0];
}

// Everything the model needs to talk about ONE card properly: the description
// (which carries real file paths, repo URLs and product links), the full
// checklist with what's already ticked, recent comments (root-cause notes and
// automated test results live there), and attachment names. Without this the
// model only sees a title and invents plausible-sounding tools that aren't
// anywhere in the project.
function buildCardBrief(db, cardId) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(card.list_id);
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(list.board_id);
  const labels = db.prepare(
    `SELECT lb.name FROM labels lb JOIN card_labels cl ON cl.label_id = lb.id
     WHERE cl.card_id = ? ORDER BY lb.id`
  ).all(card.id).map((x) => x.name);
  const checklists = db.prepare('SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id')
    .all(card.id)
    .map((cl) => ({
      title: cl.title,
      items: db.prepare('SELECT text, done FROM checklist_items WHERE checklist_id = ? ORDER BY position, id').all(cl.id)
    }));
  const comments = db.prepare('SELECT author, body FROM comments WHERE card_id = ? ORDER BY id DESC LIMIT 4')
    .all(card.id);
  const attachments = db.prepare('SELECT original_name FROM attachments WHERE card_id = ? ORDER BY id').all(card.id)
    .map((a) => a.original_name);

  return { card, list, board, labels, checklists, comments, attachments };
}

// Render the brief as plain text. Markdown-ish beats JSON here: given JSON the
// model tends to answer with JSON shaped like the input rather than reasoning
// about it.
function renderCardBrief(brief, question) {
  const { card, list, board, labels, checklists, comments, attachments } = brief;
  const out = [];
  out.push(`CARD: ${card.title}`);
  out.push(`Board: ${board.name}  |  Column: ${list.name}`);
  if (labels.length) out.push(`Labels: ${labels.join(', ')}`);
  out.push('');

  if (card.description && card.description.trim()) {
    out.push('WHAT THIS CARD SAYS (use the real paths, repos and links from here):');
    out.push(card.description.trim().slice(0, 3000));
    out.push('');
  }

  for (const cl of checklists) {
    const done = cl.items.filter((i) => i.done).length;
    out.push(`CHECKLIST "${cl.title}" — ${done}/${cl.items.length} done:`);
    for (const i of cl.items) out.push(`  [${i.done ? 'x' : ' '}] ${i.text}`);
    out.push('');
  }

  if (attachments.length) {
    out.push(`ATTACHMENTS: ${attachments.join(', ')}`);
    out.push('');
  }

  if (comments.length) {
    out.push('RECENT NOTES ON THIS CARD (these contain real findings — use them):');
    for (const c of comments) {
      out.push(`- ${c.author}: ${c.body.slice(0, 1200)}`);
    }
    out.push('');
  }

  out.push(`USER ASKED: ${question}`);
  out.push('');
  out.push(`Give the next concrete actions for "${card.title}", based on the first unticked checklist item and the real details above.`);
  return out.join('\n');
}

const SYSTEM_PROMPT = `You are the user's build coach inside Boardly, a kanban app.

The user is shipping a catalogue of small software products and gets overwhelmed by how much is outstanding. A specific card has already been chosen for them. Your only job is to turn its next unfinished step into something they can actually start right now.

Rules:
- Work ONLY on the card you are given. Never suggest a different one.
- Focus on the FIRST unticked checklist item. Ignore later-stage ones: if the Windows build isn't verified yet, say nothing about Mac builds or store graphics.
- Do NOT repeat the checklist text back. It is the input, not the answer. Expand it into actions.
- GROUND EVERY STEP IN THE CARD. The card text gives you real folder paths, repo URLs, product pages, installer filenames and notes about what is broken. Use those exact strings.
- NEVER invent a tool, service, folder or URL that does not appear on the card. Do not mention Figma, Canva, Photoshop, an "admin panel" or any other product unless the card names it. If you don't know what tool to use, describe the outcome instead and say which file or folder it belongs in.
- If the notes on the card explain a bug or root cause, your steps must act on that specific finding, naming the file and line.
- Each step is a concrete physical action doable in the next 30 minutes.
  Bad:  "Store graphics / screenshots done"
  Bad:  "Open Figma and download the brand assets"   (Figma is not mentioned on the card)
  Good: "Install Bookslot from 'Windows Installers/Bookslot/Booking-Page-Setup-1.0.0.exe' and confirm a window opens"
- Between 2 and 6 steps.

Field discipline — this matters:
- "why" is ONE short sentence explaining why this card now. It is NOT the plan. Never put steps, numbering, markdown or code in it.
- "steps" holds the actions, one per array item, plain text. Reference code as "line 43 of electron/main.js" rather than pasting a code block.
- "say" is spoken aloud: one or two short sentences, warm and direct. No markdown, no lists, no file paths or code read out, and never mention a product other than this card's.`;

// Salvage a usable plan from whatever the model actually returned. Small models
// still occasionally stuff the whole answer into one field or paste code
// blocks, so clean up rather than showing the user markdown soup.
function normalisePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;

  const clean = (v) => String(v == null ? '' : v)
    .replace(/```[\s\S]*?```/g, ' ')     // drop fenced code
    .replace(/`([^`]*)`/g, '$1')         // unwrap inline code
    // Strip markdown emphasis, but NOT underscores: identifiers like
    // ELECTRON_RUN_AS_NODE and file names depend on them, and mangling those
    // turns a correct instruction into one that silently doesn't work.
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')  // heading marks at line start only
    .replace(/^\s{0,3}>\s?/gm, '')       // blockquote marks at line start only
    .replace(/\s+/g, ' ')
    .trim();

  let steps = Array.isArray(plan.steps) ? plan.steps.map(clean).filter(Boolean) : [];
  let why = clean(plan.why);
  const say = clean(plan.say);

  // The "everything in why" failure: if why carries a numbered list and we have
  // no steps, split it back out instead of losing the answer.
  if (steps.length < 2 && /\d\s*[.)]\s+\S/.test(why)) {
    // Match from each "1." marker up to the next one, so any preamble before
    // the first marker (a heading like "Next Steps") is discarded rather than
    // becoming a bogus first step.
    const parts = [...why.matchAll(/\d+\s*[.)]\s*(.+?)(?=\s*\d+\s*[.)]\s|$)/g)]
      .map((m) => clean(m[1]))
      .filter(Boolean);
    if (parts.length >= 2) {
      steps = parts;
      why = '';
    }
  }
  if (!steps.length) return null;

  // A "why" that swallowed the plan, or that is just a field name echoed back.
  if (why.length > 200 || /^[a-z_]+$/.test(why)) why = '';

  return {
    why: why.slice(0, 200),
    steps: steps.slice(0, 6).map((s) => s.slice(0, 400)),
    say: (say || why || steps[0]).slice(0, 300)
  };
}

function extractJson(text) {
  if (!text) return null;
  // Local models like to wrap JSON in prose or ``` fences — dig it out.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching brace so trailing prose doesn't break the parse.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// The exact shape the coach must return. Passed to the model as a constrained
// schema so the keys can't drift.
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    // maxLength matters: without a ceiling a local model dumps the entire
    // answer into the first field, producing markdown-in-JSON that then fails
    // to parse. Constrained decoding enforces these.
    why: {
      type: 'string',
      maxLength: 160,
      description: 'ONE short sentence on why this card now. Not the steps.'
    },
    steps: {
      type: 'array',
      items: { type: 'string', maxLength: 320 },
      minItems: 2,
      maxItems: 6,
      description: 'one concrete action per item, plain text, no code blocks'
    },
    say: {
      type: 'string',
      maxLength: 240,
      description: 'one or two short sentences to speak aloud, plain prose'
    }
  },
  required: ['why', 'steps', 'say'],
  additionalProperties: false
};

async function chat({ settings, messages, signal, json = false, schema = null }) {
  const url = `${trimSlash(settings.chatUrl)}/chat/completions`;
  const body = {
    model: settings.chatModel,
    messages,
    temperature: 0.3,
    stream: false
  };
  // Constrained decoding. A bare "reply with only JSON" is not enough: an 8B
  // model writes prose anyway, and even a 14B will mirror the *input* objects
  // when the context is full of similar-looking JSON. Pinning the exact schema
  // forces the right keys out.
  if (json) {
    body.response_format = schema
      ? { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema } }
      : { type: 'json_object' };
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {})
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  // Not every server supports response_format — fall back rather than fail.
  if (json && (res.status === 400 || res.status === 422)) {
    delete body.response_format;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {})
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new Error(describeFetchError(err, url));
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Model server returned ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const payload = await res.json();
  return payload?.choices?.[0]?.message?.content || '';
}

async function transcribe({ settings, buffer, filename, mime }) {
  if (!settings.sttUrl) throw new Error('No speech-to-text server configured');
  const url = `${trimSlash(settings.sttUrl)}/audio/transcriptions`;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/webm' }), filename || 'speech.webm');
  form.append('model', settings.sttModel || 'whisper-1');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
      body: form
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription server returned ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const json = await res.json().catch(() => null);
  return (json && (json.text || json.transcript)) || '';
}

// Quick reachability check so the UI can tell "wrong address" from "model busy".
async function listModels(baseUrl, apiKey) {
  const url = `${trimSlash(baseUrl)}/models`;
  let res;
  try {
    res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000)
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  return (j?.data || []).map((m) => m.id).filter(Boolean).sort();
}

async function probe(settings) {
  const result = { chat: null, stt: null };
  try {
    const models = await listModels(settings.chatUrl, settings.apiKey);
    result.chat = { ok: true, models, hasModel: models.includes(settings.chatModel) };
  } catch (err) {
    result.chat = { ok: false, error: err.message };
  }

  if (settings.sttUrl) {
    try {
      const models = await listModels(settings.sttUrl, settings.apiKey);
      result.stt = { ok: true, models, hasModel: models.includes(settings.sttModel) };
    } catch (err) {
      result.stt = { ok: false, error: err.message };
    }
  }
  return result;
}

module.exports = {
  DEFAULTS, readSettings, writeSettings, buildContext,
  chat, transcribe, probe, listModels, PLAN_SCHEMA, pickCard, buildCardBrief, renderCardBrief, normalisePlan, describeFetchError, extractJson, SYSTEM_PROMPT
};
