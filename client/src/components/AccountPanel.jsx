import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { X, User, Copy, Check, KeyRound, Plus, Trash2, AlertTriangle, LogOut } from 'lucide-react';
import { api } from '../api.js';

// Same shape as McpPanel's — kept local so the two panels stay independent.
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

const day = (ts) => (ts ? ts.slice(0, 10) : 'never');

// Cloud-mode account area: who you're signed in as, and the API tokens that
// let the desktop app and AI clients authenticate as you.
export default function AccountPanel({ user, onClose, onLogout }) {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null); // the just-created token, shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/api/tokens').then(setTokens);
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const row = await api.post('/api/tokens', { name: name.trim() || 'Token' });
      setFresh(row);
      setName('');
      await load();
    } catch (err) {
      setError(err.status ? err.message : 'Could not reach the server — check your connection.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t) {
    if (!confirm(`Revoke the token "${t.name}"? Anything using it stops working immediately.`)) return;
    setError('');
    try {
      await api.del(`/api/tokens/${t.id}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

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
              <User className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Account</h2>
              <p className="text-xs text-zinc-500">Your Boardly Cloud sign-in and API tokens.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md hover:bg-zinc-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* signed in as */}
          <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl p-4">
            <div>
              <div className="text-sm font-semibold">{user?.name || user?.email}</div>
              <div className="text-xs text-zinc-500">
                {user?.email}{user?.plan ? ` · ${user.plan} plan` : ''}
              </div>
            </div>
            <button
              onClick={onLogout}
              className="flex items-center gap-2 text-sm font-semibold rounded-lg px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
              <p className="text-sm text-rose-300">{error}</p>
            </div>
          )}

          {/* the one-time reveal of a freshly created token */}
          {fresh && (
            <div className="space-y-3 bg-amber-500/5 border border-amber-500/30 rounded-xl p-4">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-200">
                  This is the only time <span className="font-semibold">{fresh.name}</span> is shown.
                  Copy it now — we store only its hash, so it can't be recovered.
                </p>
              </div>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-1 py-1">
                <code className="flex-1 text-xs text-zinc-300 font-mono truncate">{fresh.token}</code>
                <CopyButton value={fresh.token} label="Copy token" />
              </div>
              <button
                onClick={() => setFresh(null)}
                className="text-xs font-semibold text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg px-3 py-1.5 transition-colors"
              >
                I've saved it
              </button>
            </div>
          )}

          {/* tokens */}
          <div className="space-y-3">
            <label className="text-sm font-semibold">API tokens</label>
            <p className="text-xs text-zinc-600">
              Tokens authenticate as you — paste one into the desktop app to sync, or into an AI
              client to let it work on your boards.
            </p>

            {!tokens ? (
              <div className="p-6 text-center text-zinc-600 text-sm">Loading…</div>
            ) : (
              <>
                {tokens.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5">
                    <KeyRound className="w-4 h-4 text-zinc-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{t.name}</div>
                      <div className="text-xs text-zinc-500 font-mono">
                        {t.prefix}… · created {day(t.created_at)} · last used {day(t.last_used_at)}
                      </div>
                    </div>
                    <button
                      onClick={() => revoke(t)}
                      className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-rose-300 px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Revoke
                    </button>
                  </div>
                ))}
                {tokens.length === 0 && (
                  <p className="text-xs text-zinc-600">No tokens yet.</p>
                )}

                <form onSubmit={create} className="flex items-center gap-2">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Token name — e.g. Desktop sync"
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500 transition-colors"
                  />
                  <button
                    disabled={busy}
                    className="flex items-center gap-1.5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-semibold rounded-lg px-4 py-2 transition-colors shrink-0"
                  >
                    <Plus className="w-4 h-4" /> New token
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
