// Managed cloud workers must have their workspace tools before AI work starts.
// Probe only reads; never replay a possibly committed tool mutation.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function createWorkerMcp(settings, { fetchImpl = fetch, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const origin = new URL(settings.origin);
  if (origin.origin !== settings.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw Error('Invalid managed MCP origin');
  const tokenFile = settings.mcpTokenFile || '/run/secrets/boardly-mcp-token';
  const helper = [process.execPath, path.join(__dirname, 'cloud-mcp-headers.cjs'), tokenFile].map(quote).join(' ');
  const config = { url: origin.origin + '/mcp', http_headers_helper: helper, required: true, enabled: true, startup_timeout_sec: 60, default_tools_approval_mode: 'approve' };
  const codexArgs = Object.entries(config).flatMap(([key, value]) => ['-c', `mcp_servers.boardly.${key}=${JSON.stringify(value)}`]);
  async function probe(boardId) {
    // Read on every attempt so rotated credentials take effect without restart.
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!token) throw Error('Managed MCP credential missing');
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { authorization: 'Bearer ' + token }, redirect: 'error' },
      fetch: (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.any([options?.signal, AbortSignal.timeout(15000)].filter(Boolean)) }),
    });
    const client = new Client({ name: 'boardly-worker-readiness', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      for (const name of ['list_boards', 'get_board', 'get_card', 'move_card', 'add_comment']) if (!tools.some(t => t.name === name)) throw Error('Required Boardly tool missing');
      if (boardId !== undefined) {
        const result = await client.callTool({ name: 'get_board', arguments: { board_id: boardId } });
        if (result.isError || !result.content?.some(c => c.type === 'text' && (() => { try { return JSON.parse(c.text).id === boardId; } catch { return false; } })())) throw Error('Assigned project is not accessible through MCP');
      }
      return true;
    } finally { await client.close().catch(() => {}); }
  }
  async function waitUntilReady({ boardId, stopped = () => false, onStatus = async () => {} } = {}) {
    let failures = 0;
    while (!stopped()) {
      let ready = false;
      try { await probe(boardId); ready = true; } catch { /* Do not expose credentials or raw provider errors. */ }
      await onStatus(ready);
      if (ready) return true;
      const seconds = Math.min(30, 2 ** Math.min(++failures, 5));
      for (let i = 0; i < seconds && !stopped(); i++) await wait(1000);
    }
    return false;
  }
  return { codexArgs, probe, waitUntilReady };
}
module.exports = { createWorkerMcp };
