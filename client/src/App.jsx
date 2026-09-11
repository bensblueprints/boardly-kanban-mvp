import React, { lazy, Suspense, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, Building2, Plug } from 'lucide-react';
import ProfileMenu from './components/ProfileMenu.jsx';
import {accountSettings} from './components/SettingsShell.jsx';
import { api } from './api.js';
import {AccessContext} from './access.jsx';
import BrandLogo from './components/BrandLogo.jsx';
import GettingStarted from './components/GettingStarted.jsx';
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
          <BrandLogo size={44} wordmark={false} />
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

export function Workspace({ onLogout, cloud = false, access={workspaceOwner:true}, onSwitch, profile, onManageProfile }) {
  const tutorialOpen=React.useRef(null),content=React.useRef(null);
  const registerTutorial=React.useCallback(fn=>{tutorialOpen.current=fn;},[]);
  const [hash,setHash]=useState(location.hash);
  const returnRoute=React.useRef('#/');
  useEffect(()=>{const changed=()=>{setHash(location.hash);content.current?.scrollTo({top:0});if(!/^#\/(settings|account)(\/|$)/.test(location.hash))returnRoute.current=location.hash||'#/';};const open=e=>{if(!/^#\/(settings|account)(\/|$)/.test(location.hash))returnRoute.current=location.hash||'#/';location.hash='#/settings/'+(e.detail?.section||'profile');};changed();window.addEventListener('hashchange',changed);window.addEventListener('boardly-account',open);return()=>{window.removeEventListener('hashchange',changed);window.removeEventListener('boardly-account',open);};},[]);
  const settingsRoute=hash.match(/^#\/(?:settings|account)(?:\/([^/?]+))?/);
  const accountSection=settingsRoute?.[1]||'profile';
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

  return <AccessContext.Provider value={{...access,onSwitch}}><div className="h-full flex flex-col">
    {cloud&&<header className="shrink-0 flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 sm:px-6 py-3 z-40">
      <a href="#/" aria-label="Boardly workspace home" className="mr-auto shrink-0"><BrandLogo size={30}/></a>
      <nav aria-label="Workspace navigation" className="flex items-center gap-1 sm:gap-3"><a href="#/" aria-label="Companies" className="flex items-center gap-2 rounded-lg px-2 sm:px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"><Building2 size={17}/><span className="hidden sm:inline">Companies</span></a>{access.workspaceOwner&&<button onClick={()=>accountSettings('connectors')} className="flex items-center gap-2 rounded-lg px-2 sm:px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800" aria-label="Account connectors"><Plug size={17}/><span className="hidden sm:inline">Connectors</span></button>}</nav>
      {access.workspaces?.length>1&&<select aria-label="Workspace account" className="bg-zinc-900 border border-zinc-700 text-xs rounded-lg px-2 py-2 order-last w-full sm:order-none sm:w-auto sm:max-w-44" value={access.workspaceId} onChange={e=>onSwitch(e.target.value)}>{access.workspaces.map(w=><option key={w.owner_id} value={w.owner_id}>{w.name}</option>)}</select>}
      <ProfileMenu profile={profile} access={access} onLogout={onLogout} onHelp={()=>tutorialOpen.current?.()}/>
    </header>}
    {cloud&&<GettingStarted access={access} registerOpen={registerTutorial}/>}
    <div ref={content} className="flex-1 min-h-0 overflow-auto">{settingsRoute&&cloud?<AccountSettings initialSection={accountSection} profile={profile} onManageProfile={onManageProfile} onHelp={()=>tutorialOpen.current?.()} onClose={()=>location.hash=returnRoute.current}/>:boardId?<BoardView key={boardId} boardId={boardId} onBack={()=>openBoard(null)} cloud={cloud}/>:<BoardsHome onOpen={openBoard} onLogout={onLogout} cloud={cloud}/>}</div>
  </div></AccessContext.Provider>;

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
