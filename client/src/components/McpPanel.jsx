import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X, Plug, Copy, Check, Eye, EyeOff, RefreshCw, Play, Square,
  AlertTriangle, Bot, ShieldCheck
} from 'lucide-react';
import { api } from '../api.js';

function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export default function McpPanel({ onClose }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [port, setPort] = useState('');
  const [showToken, setShowToken] = useState(false);

  const load = () => api.get('/api/mcp').then((s) => {
    setStatus(s);
    setPort(String(s.port));
  });

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const start = () => act(() => api.post('/api/mcp/start', { port: Number(port) }));
  const stop = () => act(() => api.post('/api/mcp/stop'));
  const rotate = () => {
    if (!confirm('Generate a new token? Every connected AI client will stop working until you reconnect it.')) return;
    act(() => api.post('/api/mcp/token'));
  };
  const connect = (client) => act(() => api.post('/api/mcp/connect', { client }));

  const running = status?.running;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl my-4"
      >
        {/* header */}
        <div className="flex items-start justify-between p-6 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/15 flex items-center justify-center shrink-0">
              <Plug className="w-5.5 h-5.5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold">AI Integration</h2>
              <p className="text-xs text-zinc-500">
                Let Claude read and write these boards over MCP — talk to it, and the cards show up here.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md hover:bg-zinc-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {!status ? (
          <div className="p-10 text-center text-zinc-600 text-sm">Loading…</div>
        ) : (
          <div className="p-6 space-y-6">
            {/* status + start/stop */}
            <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                <div>
                  <div className="text-sm font-semibold">
                    {running ? 'Server running' : 'Server stopped'}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {running
                      ? 'Accepting connections from your AI client'
                      : 'Start the server to connect an AI client'}
                  </div>
                </div>
              </div>
              <button
                onClick={running ? stop : start}
                disabled={busy}
                className={`flex items-center gap-2 text-sm font-semibold rounded-lg px-4 py-2 transition-colors disabled:opacity-50 ${
                  running
                    ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                    : 'bg-indigo-500 hover:bg-indigo-400 text-white'
                }`}
              >
                {running ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {running ? 'Stop' : 'Start server'}
              </button>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                <p className="text-sm text-rose-300">{error}</p>
              </div>
            )}

            {/* endpoint */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold">Endpoint</label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">Port</span>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    disabled={running}
                    className="w-20 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-xs text-right outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
                  />
                </div>
              </div>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-1 py-1">
                <code className="flex-1 text-xs text-zinc-300 font-mono truncate">{status.url}</code>
                <CopyButton value={status.url} />
              </div>
              <p className="text-xs text-zinc-600">
                Bound to 127.0.0.1 — reachable only from this machine, never the network.
                {running ? '' : ' Change the port before starting if 8765 is taken.'}
              </p>
            </div>

            {/* token */}
            <div className="space-y-3">
              <label className="text-sm font-semibold">Access token</label>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-1 py-1">
                <code className="flex-1 text-xs text-zinc-300 font-mono truncate">
                  {showToken ? status.token : '•'.repeat(32)}
                </code>
                <button
                  onClick={() => setShowToken((v) => !v)}
                  className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded-md hover:bg-zinc-800 transition-colors shrink-0"
                >
                  {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <CopyButton value={status.token} />
                <button
                  onClick={rotate}
                  disabled={busy}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> New
                </button>
              </div>
            </div>

            {/* one-click connect */}
            <div className="space-y-3">
              <label className="text-sm font-semibold">Connect an AI client</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {status.clients.map((c) => (
                  <div key={c.id} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex items-center gap-2.5">
                      <Bot className="w-4 h-4 text-indigo-400 shrink-0" />
                      <span className="text-sm font-semibold">{c.label}</span>
                    </div>
                    <div className="text-xs">
                      {c.connected && !c.stale && (
                        <span className="flex items-center gap-1.5 text-emerald-400">
                          <ShieldCheck className="w-3.5 h-3.5" /> Connected
                        </span>
                      )}
                      {c.connected && c.stale && (
                        <span className="flex items-center gap-1.5 text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5" /> Out of date — reconnect
                        </span>
                      )}
                      {!c.connected && <span className="text-zinc-600">Not connected</span>}
                    </div>
                    <button
                      onClick={() => connect(c.id)}
                      disabled={busy}
                      className="w-full text-xs font-semibold rounded-lg py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 transition-colors disabled:opacity-50"
                    >
                      {c.connected ? 'Reconnect' : 'Connect'}
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-600">
                Writes the config for you (a <code className="text-zinc-500">.boardly-backup</code> copy is kept).
                Restart the client afterwards so it picks up the change.
              </p>
            </div>

            {/* manual config */}
            <details className="group">
              <summary className="text-sm font-semibold cursor-pointer text-zinc-400 hover:text-zinc-200 transition-colors">
                Configure another client manually
              </summary>
              <div className="mt-3 flex items-start gap-1 bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <pre className="flex-1 text-xs text-zinc-400 font-mono overflow-x-auto">
{JSON.stringify(status.config, null, 2)}
                </pre>
                <CopyButton value={JSON.stringify(status.config, null, 2)} />
              </div>
            </details>

            <div className="text-xs text-zinc-600 border-t border-zinc-800 pt-4">
              Once connected, ask Claude things like <span className="text-zinc-400">
              “make a board for this week and add what I told you about”</span> — it can create boards,
              lists, cards, labels, checklists and comments here.
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
