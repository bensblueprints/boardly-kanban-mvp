// In-app MCP endpoint — streamable HTTP transport served by the running Boardly app.
//
// Why a second listener instead of mounting on the main app: the desktop app
// binds port 0 (a random free port each launch), so a URL pasted into an AI
// client would break on every restart. This binds a stable, user-configurable
// port (default 8765) on 127.0.0.1 only, so the endpoint you configure once
// keeps working.
//
// Auth: every request must carry `Authorization: Bearer <token>`. The token is
// generated per install and stored in dataDir/mcp.json.
//
// Stateless mode: a fresh McpServer + transport per request. The tools hold no
// cross-request state (all state is the SQLite DB), so this avoids session
// bookkeeping and survives client reconnects.

const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createBoardlyServer } = require('./tools.js');

const HOST = '127.0.0.1';

function startMcpHttp({ db, uploadsDir, port, token }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.use((req, res, next) => {
    const header = req.get('authorization') || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || supplied !== token) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized — send Authorization: Bearer <token> from Boardly Settings → Integrations' },
        id: null
      });
    }
    next();
  });

  app.post('/mcp', async (req, res) => {
    const server = createBoardlyServer({ db, uploadsDir });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message || 'Internal error' },
          id: null
        });
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to terminate.
  const methodNotAllowed = (req, res) => res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed — this endpoint is stateless, use POST' },
    id: null
  });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return new Promise((resolve, reject) => {
    const listener = app.listen(port, HOST, () => {
      resolve({
        port: listener.address().port,
        url: `http://${HOST}:${listener.address().port}/mcp`,
        close: () => new Promise((done) => listener.close(done))
      });
    });
    listener.on('error', (err) => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use — pick another port in Settings → Integrations`)
        : err);
    });
  });
}

module.exports = { startMcpHttp };
