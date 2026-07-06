import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { KanbanSquare, Lock } from 'lucide-react';
import { api } from './api.js';
import BoardsHome from './components/BoardsHome.jsx';
import BoardView from './components/BoardView.jsx';

function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/login', { password });
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        onSubmit={submit}
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
        <label className="block text-sm text-zinc-400 mb-1.5">Password</label>
        <div className="relative">
          <Lock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-indigo-500 transition-colors"
            placeholder="••••••••"
          />
        </div>
        {error && <p className="text-rose-400 text-sm mt-3">{error}</p>}
        <button
          disabled={busy}
          className="w-full mt-5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </motion.form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [boardId, setBoardId] = useState(() => {
    const m = location.hash.match(/^#\/board\/(\d+)/);
    return m ? Number(m[1]) : null;
  });

  useEffect(() => {
    api.get('/api/me').then((r) => setAuthed(r.authed)).catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const onHash = () => {
      const m = location.hash.match(/^#\/board\/(\d+)/);
      setBoardId(m ? Number(m[1]) : null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function openBoard(id) {
    location.hash = id ? `#/board/${id}` : '#/';
  }

  if (authed === null) return <div className="h-full flex items-center justify-center text-zinc-600">Loading…</div>;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return boardId
    ? <BoardView boardId={boardId} onBack={() => openBoard(null)} />
    : <BoardsHome onOpen={openBoard} onLogout={() => api.post('/api/logout').then(() => setAuthed(false))} />;
}
