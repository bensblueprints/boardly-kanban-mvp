// Boardly MCP server — stdio transport.
//
// This entry is for AI clients that spawn the server themselves (Claude Desktop,
// `claude mcp add`). It opens Boardly's SQLite DB directly; WAL mode makes
// concurrent access with a running Boardly app safe.
//
// The Boardly desktop app itself does NOT use this file — it serves the same
// tools over HTTP from inside the running app (see mcp/http.js), which keeps a
// stable URL and avoids needing a separate node install.
//
// Data dir: BOARDLY_DATA_DIR, else %APPDATA%\boardly\data, else ../data.

const path = require('path');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { openDb } = require('../server/db.js');
const { createBoardlyServer, resolveDataDir } = require('./tools.js');

async function main() {
  const dataDir = resolveDataDir();
  const db = openDb(dataDir);
  const server = createBoardlyServer({ db, uploadsDir: path.join(dataDir, 'uploads') });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Boardly MCP server running (data: ${dataDir})`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
