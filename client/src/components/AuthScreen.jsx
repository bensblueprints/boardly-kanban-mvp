import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { KanbanSquare, Lock, Mail, User } from 'lucide-react';
import { api } from '../api.js';

// Cloud-mode sign in / register. The desktop app never renders this — it is
// gated on /api/me's `mode` in App.jsx.
export default function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setBusy(true);
    try {
      // Register auto-logs-in server-side (it plants the session cookie).
      await api.post(mode === 'register' ? '/api/register' : '/api/login', { email, password, name });
      onLogin();
    } catch (err) {
      // A fetch failure has no status — say so instead of showing "fetch failed".
      setError(err.status ? err.message : 'Could not reach the server — check your connection.');
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError('');
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8 shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-indigo-500/15 flex items-center justify-center">
            <KanbanSquare className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Boardly</h1>
            <p className="text-xs text-zinc-500">Your boards. Your server. No per-seat fees.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 bg-zinc-950 border border-zinc-800 rounded-lg p-1 mb-6">
          {[['login', 'Sign in'], ['register', 'Create account']].map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`text-sm font-semibold rounded-md py-1.5 transition-colors ${
                mode === m ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.form
            key={mode}
            initial={{ opacity: 0, x: mode === 'register' ? 10 : -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onSubmit={submit}
          >
            {mode === 'register' && (
              <>
                <label className="block text-sm text-zinc-400 mb-1.5">Name</label>
                <div className="relative mb-4">
                  <User className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                    placeholder="What should we call you?"
                  />
                </div>
              </>
            )}
            <label className="block text-sm text-zinc-400 mb-1.5">Email</label>
            <div className="relative mb-4">
              <Mail className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                placeholder="you@example.com"
              />
            </div>
            <label className="block text-sm text-zinc-400 mb-1.5">Password</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
                placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
              />
            </div>
            {error && <p className="text-rose-400 text-sm mt-3">{error}</p>}
            <button
              disabled={busy}
              className="w-full mt-5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
            >
              {busy
                ? (mode === 'register' ? 'Creating account…' : 'Signing in…')
                : (mode === 'register' ? 'Create account' : 'Sign in')}
            </button>
          </motion.form>
        </AnimatePresence>

        <p className="text-xs text-zinc-600 mt-5 text-center">
          {mode === 'register'
            ? 'Free while Boardly Cloud is in early access.'
            : 'No account yet? Create one above — it takes ten seconds.'}
        </p>
      </motion.div>
    </div>
  );
}
