import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceSession from './WorkspaceSession.jsx';
import { nativeRequest, nativeToken } from './native-bridge.js';
import { setDownloadProvider } from './api.js';
import './index.css';

function NativeWorkspace() {
  const [session, setSession] = useState(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError('');
    nativeRequest('ready').then(value => {
      if (!alive) return;
      if (!/^user_[A-Za-z0-9]+$/.test(value.userId) || !/^user_[A-Za-z0-9]+$/.test(value.workspaceId)) throw new Error('Sign in again to open this workspace.');
      sessionStorage.setItem('boardly-workspace:' + value.userId, value.workspaceId);
      setDownloadProvider((url, name, workspaceId, content) => nativeRequest(content === undefined ? 'download' : 'shareText', { url, name, workspaceId, content }));
      setSession(value);
    }).catch(failure => { if (alive) setError(failure.message); });
    return () => { alive = false; setDownloadProvider(null); };
  }, [attempt]);
  if (error) return <main className="h-full flex flex-col items-center justify-center p-6 gap-5"><h1 className="text-xl font-semibold">Open your workspace</h1><p className="text-zinc-400 text-center">{error}</p><button className="text-lime-300" onClick={() => setAttempt(value => value + 1)}>Try again</button><a href="/app" className="text-zinc-400">Open Boardly in the browser</a></main>;
  if (!session) return <div className="h-full flex items-center justify-center">Opening Boardly…</div>;
  return <WorkspaceSession userId={session.userId} getToken={nativeToken} onLogout={() => nativeRequest('signout')} />;
}

createRoot(document.getElementById('root')).render(<NativeWorkspace />);
