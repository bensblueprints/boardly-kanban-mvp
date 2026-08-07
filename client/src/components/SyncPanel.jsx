import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Cloud, CloudOff, RefreshCw, AlertTriangle, ShieldCheck, Unplug } from 'lucide-react';
import { api } from '../api.js';

// Desktop "Connect to Boardly Cloud" panel. The desktop keeps working fully
// offline; this only wires up background sync with a server URL + API token
// (created in the cloud Account panel).
export default function SyncPanel({ status, onClose, onChanged }) {
  const [url, setUrl] = useState(status?.url || 'https://boardly.onetimesuite.com');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/sync/connect', { url, token });
      onChanged();
    } catch (err) {
      setError(err.status ? err.message : 'Could not reach the server — check the URL and your connection.');
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      await api.post('/api/sync/now');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect from Boardly Cloud? Your local boards stay exactly as they are.')) return;
    setBusy(true);
    try {
      await api.post('/api/sync/disconnect');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const configured = status?.configured;
  const offline = configured && status.state === 'offline';

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl my-4"
      >
        {/* header */}
        <div className="flex items-start justify-between p-6 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/15 flex items-center justify-center shrink-0">
              <Cloud className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Boardly Cloud</h2>
              <p className="text-xs text-zinc-500">Sync these boards with your cloud account. Offline still works.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md hover:bg-zinc-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {!configured ? (
            <form onSubmit={connect} className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">Server</label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                  placeholder="https://boardly.onetimesuite.com"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">API token</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                  placeholder="Paste the token from Account → API tokens"
                />
                <p className="text-xs text-zinc-600 mt-2">
                  Sign in on the web, open Account → API tokens, create a token and paste it here.
                </p>
              </div>
              {error && (
                <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">
                  <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-rose-300">{error}</p>
                </div>
              )}
              <button
                disabled={busy}
                className="w-full bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
              >
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    offline ? 'bg-amber-400' : status.state === 'syncing' ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-400'
                  }`} />
                  <div>
                    <div className="text-sm font-semibold">
                      {offline ? 'Offline' : status.state === 'syncing' ? 'Syncing…' : 'Connected'}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {offline
                        ? (status.lastError || 'Will retry on its own')
                        : status.lastSyncAt
                          ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}`
                          : 'Waiting for first sync'}
                    </div>
                  </div>
                </div>
                {offline
                  ? <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />
                  : <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />}
              </div>

              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
                <code className="flex-1 text-xs text-zinc-400 font-mono truncate">{status.url}</code>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={syncNow}
                  disabled={busy}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-semibold rounded-lg py-2 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" /> Sync now
                </button>
                <button
                  onClick={disconnect}
                  disabled={busy}
                  className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-rose-300 px-3 py-2 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50"
                >
                  <Unplug className="w-4 h-4" /> Disconnect
                </button>
              </div>
              {status.pendingBlobs > 0 && (
                <p className="text-xs text-amber-400/90">
                  {status.pendingBlobs} file{status.pendingBlobs === 1 ? '' : 's'} pending —
                  attachment bytes move when hosted storage allows it; they stay safe locally either way.
                </p>
              )}
              <p className="text-xs text-zinc-600">
                Changes sync both ways every 30 seconds. Without a connection everything stays local — nothing is lost.
              </p>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
