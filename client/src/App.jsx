import React, { lazy, Suspense, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { KanbanSquare, Lock } from 'lucide-react';
import { api } from './api.js';
import {AccessContext} from './access.jsx';
import AccountSettings from './components/AccountSettings.jsx';
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

function LocalApp() {
  const [authed, setAuthed] = useState(null);
  useEffect(() => {
    api.get('/api/me').then((r) => setAuthed(r.authed)).catch(() => setAuthed(false));
  }, []);
  if (authed === null) return <div className="h-full flex items-center justify-center text-zinc-600">Loading…</div>;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <Workspace onLogout={() => api.post('/api/logout').then(() => setAuthed(false))} />;
}

export function Workspace({ onLogout, cloud = false, access={workspaceOwner:true}, onSwitch }) {
  const [accountOpen,setAccountOpen]=useState(location.hash==='#/account');
  useEffect(()=>{const open=()=>setAccountOpen(true);window.addEventListener('boardly-account',open);return()=>window.removeEventListener('boardly-account',open);},[]);
  const [boardId, setBoardId] = useState(() => {
    const m = location.hash.match(/^#\/board\/(\d+)/);
    return m ? Number(m[1]) : null;
  });

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

  return <AccessContext.Provider value={access}><div className="h-full flex flex-col">{cloud&&<div className="shrink-0 flex justify-end items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-5 py-2 text-xs"><span className="text-zinc-400">{access.workspaceOwner?'Account owner':'Shared workspace'}</span>{access.workspaces?.length>1&&<select aria-label="Workspace account" className="bg-zinc-900 rounded px-2 py-1" value={access.workspaceId} onChange={e=>onSwitch(e.target.value)}>{access.workspaces.map(w=><option key={w.owner_id} value={w.owner_id}>{w.name}</option>)}</select>}<button onClick={()=>setAccountOpen(true)} className="text-indigo-300">Account & AI</button></div>}{accountOpen&&cloud&&<AccountSettings onClose={()=>{setAccountOpen(false);if(location.hash==='#/account')location.hash='#/';}}/>}<div className="flex-1 min-h-0">{boardId?<BoardView boardId={boardId} onBack={()=>openBoard(null)} cloud={cloud}/>:<BoardsHome onOpen={openBoard} onLogout={onLogout} cloud={cloud}/>}</div></div></AccessContext.Provider>;
}

const CloudApp = lazy(() => import('./CloudApp.jsx'));

export default function App() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => { api.get('/api/auth-config').then(setConfig).catch(() => setError(true)); }, []);
  if (error) return <div className="h-full flex flex-col gap-4 items-center justify-center">
    <p>Boardly could not connect. Please try again.</p>
    <button onClick={() => location.reload()} className="text-indigo-400">Retry</button>
  </div>;
  if (!config) return <div className="h-full flex items-center justify-center">Loading Boardly…</div>;
  return config.mode === 'clerk'
    ? <Suspense fallback={<div className="h-full flex items-center justify-center">Loading sign-in…</div>}><CloudApp config={config} /></Suspense>
    : <LocalApp />;
}
