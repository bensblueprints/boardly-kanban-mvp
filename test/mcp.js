// Round-trip test for the Boardly MCP server.
// Spawns mcp/server.js with BOARDLY_DATA_DIR pointed at a temp dir, then
// drives it over stdio JSON-RPC: initialize -> tools/list -> create board,
// list, card, checklist, item, label, assign, comment -> get_board.
// The real Boardly DB is never touched. Run: node test/mcp.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardly-mcp-test-'));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
  env: { ...process.env, BOARDLY_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'inherit']
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function callTool(name, args) {
  return rpc('tools/call', { name, arguments: args }).then((r) => {
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  });
}

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { failures++; console.error(`FAIL  ${label}`); }
}

(async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'boardly-mcp-test', version: '0.0.0' }
  });
  check('initialize handshake', init && init.serverInfo && init.serverInfo.name === 'boardly');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const { tools } = await rpc('tools/list', {});
  const names = tools.map((t) => t.name);
  console.log(`tools/list: ${names.length} tools`);
  for (const t of ['list_boards', 'get_board', 'create_board', 'create_list', 'create_card',
    'move_card', 'create_label', 'assign_label', 'add_checklist', 'add_checklist_item',
    'set_checklist_item', 'add_comment', 'update_card', 'delete_card']) {
    check(`tool exposed: ${t}`, names.includes(t));
  }

  const board = await callTool('create_board', { name: 'Test Board', emoji: '🧪' });
  check('create_board', board.id > 0 && board.name === 'Test Board');

  const listA = await callTool('create_list', { board_id: board.id, name: 'To Do' });
  const listB = await callTool('create_list', { board_id: board.id, name: 'Done' });
  check('create_list x2', listA.id > 0 && listB.id > 0 && listB.position === 1);

  const card = await callTool('create_card', {
    list_id: listA.id, title: 'Write tests', description: 'Cover the MCP server', due_date: '2026-08-15'
  });
  check('create_card', card.id > 0 && card.due_date === '2026-08-15');

  const cl = await callTool('add_checklist', { card_id: card.id, title: 'Steps' });
  const item = await callTool('add_checklist_item', { checklist_id: cl.id, text: 'Run the test' });
  const itemDone = await callTool('set_checklist_item', { item_id: item.id, done: true });
  check('checklist item done + progress', itemDone.done === 1 && itemDone.progress.done === 1 && itemDone.progress.total === 1);

  const label = await callTool('create_label', { board_id: board.id, name: 'urgent', color: '#ef4444' });
  const assigned = await callTool('assign_label', { card_id: card.id, label_id: label.id });
  check('assign_label', assigned.labels.length === 1 && assigned.labels[0].name === 'urgent');

  const comment = await callTool('add_comment', { card_id: card.id, body: 'Looks good', author: 'Kimi' });
  check('add_comment', comment.author === 'Kimi');

  const moved = await callTool('move_card', { card_id: card.id, list_id: listB.id, position: 0 });
  check('move_card', moved.list_id === listB.id && moved.position === 0);

  const updated = await callTool('update_card', { card_id: card.id, due_date: null });
  check('update_card clears due date', updated.due_date === null);

  const full = await callTool('get_board', { board_id: board.id });
  const doneList = full.lists.find((l) => l.name === 'Done');
  check('get_board reflects everything',
    full.lists.length === 2 && doneList.cards.length === 1 &&
    doneList.cards[0].labels[0].name === 'urgent' &&
    doneList.cards[0].checklist.total === 1 && full.labels.length === 1);

  const boards = await callTool('list_boards', {});
  check('list_boards', boards.length === 1 && boards[0].card_count === 1 && boards[0].list_count === 2);

  const err = await rpc('tools/call', { name: 'get_board', arguments: { board_id: 9999 } });
  check('missing board -> isError', err.isError === true);

  child.stdin.end();
  child.kill();
  await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(failures === 0 ? '\nAll MCP tests passed.' : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test crashed:', err);
  child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(1);
});
