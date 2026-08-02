// MCP settings persistence + one-click client wiring.
//
// Settings live in dataDir/mcp.json (next to app.db) so they survive app
// upgrades. The bearer token is generated once on first read.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PORT = 8765;
const SERVER_KEY = 'boardly';

function settingsPath(dataDir) {
  return path.join(dataDir, 'mcp.json');
}

function readSettings(dataDir) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
  } catch {
    saved = {};
  }
  const settings = {
    enabled: saved.enabled === true,
    port: Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536 ? saved.port : DEFAULT_PORT,
    token: typeof saved.token === 'string' && saved.token.length >= 32
      ? saved.token
      : crypto.randomBytes(24).toString('hex')
  };
  // Persist the generated token so the endpoint config stays stable.
  if (settings.token !== saved.token) writeSettings(dataDir, settings);
  return settings;
}

function writeSettings(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath(dataDir), JSON.stringify(settings, null, 2));
  return settings;
}

function endpointUrl(port) {
  return `http://127.0.0.1:${port}/mcp`;
}

// The config block a user pastes into any MCP client.
function clientConfigEntry({ port, token }) {
  return {
    type: 'http',
    url: endpointUrl(port),
    headers: { Authorization: `Bearer ${token}` }
  };
}

// Where each supported client keeps its config.
function clientTargets() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return {
    'claude-code': {
      label: 'Claude Code',
      file: path.join(home, '.claude.json')
    },
    'claude-desktop': {
      label: 'Claude Desktop',
      file: process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(appData, 'Claude', 'claude_desktop_config.json')
    }
  };
}

// Merge our server entry into a client's config, preserving everything else.
// Takes a timestamped backup before the first write to any given file.
function connectClient(clientId, { port, token }) {
  const target = clientTargets()[clientId];
  if (!target) throw new Error(`Unknown client "${clientId}"`);

  let config = {};
  let existed = false;
  if (fs.existsSync(target.file)) {
    existed = true;
    const raw = fs.readFileSync(target.file, 'utf8');
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${target.label} config at ${target.file} is not valid JSON — fix or move it, then retry`);
    }
    fs.writeFileSync(`${target.file}.boardly-backup`, raw);
  } else {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  config.mcpServers[SERVER_KEY] = clientConfigEntry({ port, token });
  fs.writeFileSync(target.file, JSON.stringify(config, null, 2));

  return {
    ok: true,
    client: target.label,
    file: target.file,
    created: !existed,
    backup: existed ? `${target.file}.boardly-backup` : null
  };
}

function clientStatus({ port, token }) {
  const targets = clientTargets();
  return Object.entries(targets).map(([id, t]) => {
    let connected = false;
    let stale = false;
    try {
      const config = JSON.parse(fs.readFileSync(t.file, 'utf8'));
      const entry = config?.mcpServers?.[SERVER_KEY];
      if (entry) {
        connected = true;
        stale = entry.url !== endpointUrl(port) ||
          entry.headers?.Authorization !== `Bearer ${token}`;
      }
    } catch {
      // no config file yet, or unreadable — treated as not connected
    }
    return { id, label: t.label, file: t.file, connected, stale };
  });
}

module.exports = {
  DEFAULT_PORT,
  SERVER_KEY,
  readSettings,
  writeSettings,
  endpointUrl,
  clientConfigEntry,
  clientTargets,
  connectClient,
  clientStatus
};
