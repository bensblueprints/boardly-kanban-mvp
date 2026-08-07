import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { X, Share2, Copy, Check, Plus, Trash2, AlertTriangle } from 'lucide-react';
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

const shareUrl = (token) => `${location.origin}/#/share/${token}`;

// Owner-only, cloud-mode board sharing: create read-only public links,
// copy them out, revoke them when they should stop working.
export default function SharePanel({ boardId, onClose }) {
  const [links, setLinks] = useState(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get(`/api/boards/${boardId}/share`).then(setLinks);
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/boards/${boardId}/share`, { label: label.trim() });
      setLabel('');
      await load();
    } catch (err) {
      setError(err.status ? err.message : 'Could not reach the server — check your connection.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link) {
    if (!confirm(`Revoke "${link.label || 'this link'}"? Anyone with the URL loses access immediately.`)) return;
    setError('');
    try {
      await api.del(`/api/share/${link.id}`);
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
        className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl my-4"
      >
        <div className="flex items-start justify-between p-6 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/15 flex items-center justify-center shrink-0">
              <Share2 className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Share this board</h2>
              <p className="text-xs text-zinc-500">
                A read-only snapshot anyone with the link can view. No comments, no attachments.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md hover:bg-zinc-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
              <p className="text-sm text-rose-300">{error}</p>
            </div>
          )}

          {!links ? (
            <div className="p-6 text-center text-zinc-600 text-sm">Loading…</div>
          ) : (
            <>
              {links.map((l) => (
                <div key={l.id} className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-1 py-1">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{l.label || 'Shared board'}</div>
                    <code className="block text-xs text-zinc-500 font-mono truncate">{shareUrl(l.token)}</code>
                  </div>
                  <CopyButton value={shareUrl(l.token)} label="Copy link" />
                  <button
                    onClick={() => revoke(l)}
                    className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-rose-300 px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Revoke
                  </button>
                </div>
              ))}
              {links.length === 0 && (
                <p className="text-xs text-zinc-600">No active links yet.</p>
              )}

              <form onSubmit={create} className="flex items-center gap-2">
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Label — e.g. For the client"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500 transition-colors"
                />
                <button
                  disabled={busy}
                  className="flex items-center gap-1.5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-semibold rounded-lg px-4 py-2 transition-colors shrink-0"
                >
                  <Plus className="w-4 h-4" /> New link
                </button>
              </form>
              <p className="text-xs text-zinc-600">
                The snapshot updates as the board changes. Revoking kills the link instantly.
              </p>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
