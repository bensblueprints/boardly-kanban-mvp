import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X, Cloud, RefreshCw, AlertTriangle, ExternalLink, CheckCircle2, Unplug
} from 'lucide-react';
import { api } from '../api.js';

// Placeholder Whop checkout for the paid Cloud Sync add-on.
const SYNC_CHECKOUT_URL = 'https://whop.com/boardly/';
// Production sync server, editable in the form (e.g. self-hosted).
const DEFAULT_SYNC_SERVER_URL = 'https://boardly-api.onetimesuite.com';

export default function SyncPanel({ onClose }) {
  const [status, setStatus] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SYNC_SERVER_URL);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/api/sync/status').then((s) => {
    setStatus(s);
    if (s.serverUrl) setServerUrl(s.serverUrl);
  });

  // Poll while the panel is open so pending count / last sync stay fresh.
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const t = setInterval(() => load().catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      const s = await fn();
      if (s) setStatus(s);
    } catch (err) {
      setError(err.message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function connect(e) {
    e.preventDefault();
    await act(() => api.post('/api/sync/config', { serverUrl: serverUrl.trim(), token: token.trim() }));
    setToken('');
  }

  const syncNow = () => act(() => api.post('/api/sync/now'));
  const disconnect = () => act(() => api.post('/api/sync/disable'));

  const connected = !!status?.enabled;

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
              <Cloud className="w-5.5 h-5.5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Cloud Sync</h2>
              <p className="text-xs text-zinc-500">Sync boards across devices — your data stays yours.</p>
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
            {error && (
              <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                <p className="text-sm text-rose-300">{error}</p>
              </div>
            )}

            {connected ? (
              <>
                {/* status + actions */}
                <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                    <div>
                      <div className="text-sm font-semibold">Connected</div>
                      <div className="text-xs text-zinc-500 truncate max-w-72">{status.serverUrl}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={syncNow}
                      disabled={busy}
                      className="flex items-center gap-2 text-sm font-semibold rounded-lg px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Sync now
                    </button>
                    <button
                      onClick={disconnect}
                      disabled={busy}
                      className="flex items-center gap-2 text-sm font-semibold rounded-lg px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
                    >
                      <Unplug className="w-4 h-4" /> Disconnect
                    </button>
                  </div>
                </div>

                {/* account + sync detail */}
                <div className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Subscription</span>
                    {status.account ? (
                      status.account.active ? (
                        <span className="flex items-center gap-1.5 text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Active{status.account.renews_at ? ` · renews ${new Date(status.account.renews_at).toLocaleDateString()}` : ''}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5" /> {status.account.status || 'Inactive'}
                        </span>
                      )
                    ) : (
                      <span className="text-zinc-600">Unknown</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Last sync</span>
                    <span className="text-zinc-300">
                      {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Never'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Pending changes</span>
                    <span className="text-zinc-300">{status.pendingChanges}</span>
                  </div>
                </div>

                {status.lastError && (
                  <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-sm text-amber-300">{status.lastError}</p>
                  </div>
                )}
              </>
            ) : !expanded && !status.hasToken ? (
              /* collapsed teaser for free users */
              <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                <p className="text-sm text-zinc-400">Cloud Sync — sync boards across devices.</p>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={SYNC_CHECKOUT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
                  >
                    Learn more <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => setExpanded(true)}
                    className="text-sm font-semibold rounded-lg px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white transition-colors"
                  >
                    Set up
                  </button>
                </div>
              </div>
            ) : (
              /* connect form */
              <form onSubmit={connect} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Sync server</label>
                  <input
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                    placeholder={DEFAULT_SYNC_SERVER_URL}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Access token</label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                    placeholder="Paste your token from the Boardly account portal"
                  />
                </div>
                {status.lastError && (
                  <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-sm text-amber-300">{status.lastError}</p>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    disabled={busy || !token.trim() || !serverUrl.trim()}
                    className="text-sm font-semibold rounded-lg px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white transition-colors disabled:opacity-50"
                  >
                    {busy ? 'Connecting…' : 'Connect'}
                  </button>
                  <a
                    href={SYNC_CHECKOUT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
                  >
                    Get a token <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
                <p className="text-xs text-zinc-600">
                  Cloud Sync is a paid add-on. Boards are stored on the sync server as opaque
                  payloads and are never viewable in a browser.
                </p>
              </form>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
