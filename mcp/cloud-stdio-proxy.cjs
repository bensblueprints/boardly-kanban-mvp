// Runs inside the current cloud container over SSH. The first private input
// line is the existing MCP key; subsequent lines are standard JSON-RPC.
const readline = require('node:readline');
let token;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  if (token === undefined) { token = line.trim(); if (!/^bdly_[A-Za-z0-9_-]+$/.test(token)) process.exit(1); return; }
  let request;
  try {
    request = JSON.parse(line);
    const response = await fetch('http://127.0.0.1:5315/mcp', { method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify(request), signal: AbortSignal.timeout(180000) });
    const body = await response.text();
    if (!body.trim()) return;
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) process.stdout.write(JSON.stringify(JSON.parse(data)) + '\n');
      }
    } else {
      const result = JSON.parse(body);
      process.stdout.write(JSON.stringify(result.jsonrpc ? result : { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32001, message: result.error || 'Cloud MCP request failed' } }) + '\n');
    }
  } catch {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Cloud MCP request failed. Check the connection and saved state before retrying a change.' } }) + '\n');
  }
});
