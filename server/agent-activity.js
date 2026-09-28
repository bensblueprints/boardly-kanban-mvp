const { redact } = require('./project-environment');

function maskCardNumbers(text) {
  return text.replace(/\b\d(?:[ -]*\d){12,18}\b/g, match => {
    const digits = match.replace(/[ -]/g, '');
    let sum = 0;
    for (let i = digits.length - 1, doubled = false; i >= 0; i--, doubled = !doubled) { let n = Number(digits[i]); if (doubled && (n *= 2) > 9) n -= 9; sum += n; }
    return sum % 10 === 0 ? '[REDACTED CARD]' : match;
  });
}

function safeText(value, secrets = {}) {
  return maskCardNumbers(redact(String(value || ''), secrets))
    .replace(/\b(?:bdly_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

// Show the operation, not raw shell arguments, scripts, output or credentials.
function commandTitle(command) {
  const text = String(command || '');
  const boardly = text.match(/\bboardly-(?:cloud-)?mcp\s+(list_boards|get_board|find_cards|get_card|create_board|create_list|create_card|update_card|move_card|add_comment|add_checklist|add_checklist_item|set_checklist_item|create_label|assign_label|tools)\b/);
  if (boardly) return `Boardly · ${boardly[1]}`;
  const git = text.match(/\bgit\s+(status|diff|log|show|branch|checkout|switch|commit|fetch|pull|push|merge|rebase|add|worktree)\b/);
  if (git) return `Running git ${git[1]}`;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint)\b|\b(?:pytest|cargo test|go test)\b/.test(text)) return 'Running tests and checks';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:docker|cargo)\s+build\b/.test(text)) return 'Building the project';
  if (/\b(?:ssh|scp|rsync)\b/.test(text)) return 'Working with the project server';
  if (/\b(?:rg|grep|find)\b/.test(text)) return 'Searching project files';
  if (/\b(?:cat|sed|head|tail)\b/.test(text)) return 'Reading project files';
  if (/\bpython[23]?\b/.test(text)) return 'Running a Python script';
  if (/\bnode\b/.test(text)) return 'Running a Node.js script';
  if (/\b(?:curl|wget)\b/.test(text)) return 'Requesting a web resource';
  if (/\b(?:npm|pnpm|yarn|bun|pip|apt|flatpak)\s+(?:install|add)\b/.test(text)) return 'Installing project dependencies';
  if (/\bpwd\b/.test(text)) return 'Checking the project directory';
  if (/\bls\b/.test(text)) return 'Listing project files';
  return 'Running a shell command';
}

function eventActivity(event, secrets = {}) {
  if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) return null;
  const item = event.item;
  if (!item || typeof item.id !== 'string') return null;
  const done = event.type === 'item.completed';
  let kind, title, detail = '';
  let status = done ? 'completed' : 'running';
  if (item.type === 'agent_message') {
    if (!done || !item.text) return null;
    kind = 'update'; title = 'Progress update'; detail = item.text;
  } else if (item.type === 'command_execution') {
    kind = 'command'; title = commandTitle(item.command);
    if (Number.isInteger(item.exit_code)) { detail = `Exit code ${item.exit_code}`; if (item.exit_code !== 0) status = 'failed'; }
  } else if (item.type === 'mcp_tool_call') {
    kind = 'tool'; title = `${item.server || 'Project tool'} · ${item.tool || 'Tool call'}`;
    const args = item.arguments || {};
    detail = ['board_id','card_id'].filter(k => Number.isSafeInteger(args[k])).map(k => `${k === 'board_id' ? 'Project' : 'Task'} #${args[k]}`).join(' · ');
    if (item.error || item.result?.isError || item.status === 'failed') status = 'failed';
  } else if (item.type === 'file_change') {
    kind = 'file'; title = 'Updating project files';
    detail = (item.changes || []).slice(0, 20).map(c => `${c.kind || 'update'}: ${c.path}`).join('\n');
    if (item.status === 'failed') status = 'failed';
  } else if (item.type === 'web_search') {
    kind = 'search'; title = 'Searching the web'; detail = item.query || '';
  } else if (item.type === 'todo_list') {
    kind = 'plan'; title = 'Task plan';
    detail = (item.items || []).slice(0, 20).map(i => `${i.completed ? '✓' : '○'} ${i.text}`).join('\n');
  } else return null; // Private reasoning and raw tool output never enter the feed.
  return { key: item.id, kind, title: safeText(title, secrets).slice(0, 200), detail: safeText(detail, secrets).slice(0, 3000), status };
}
module.exports = { safeText, commandTitle, eventActivity };
