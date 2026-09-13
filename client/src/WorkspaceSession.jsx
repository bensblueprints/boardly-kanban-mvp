import React, { useEffect, useState } from 'react';
import { api, setTokenProvider, setWorkspaceId } from './api.js';
import { Workspace } from './App.jsx';

const savedWorkspace = userId => {
  try { return sessionStorage.getItem('boardly-workspace:' + userId); } catch { return null; }
};
const rememberWorkspace = (userId, id) => {
  try {
    if (id) sessionStorage.setItem('boardly-workspace:' + userId, id);
    else sessionStorage.removeItem('boardly-workspace:' + userId);
  } catch { /* Storage may be unavailable; the current session still works. */ }
};

export default function WorkspaceSession({ userId, getToken, onLogout, profile, onManageProfile }) {
  const [access, setAccess] = useState(null);
  const [selection, setSelection] = useState(() => ({ id: savedWorkspace(userId) }));
  useEffect(() => {
    let active = true, busy = false, workspaceId = selection.id;
    setAccess(null);
    setTokenProvider(getToken);
    setWorkspaceId(workspaceId);
    async function refresh() {
      if (!active || busy) return;
      busy = true;
      try {
        const result = await api.get('/api/me');
        if (!active) return;
        // Revocation can select another account. Never reuse the old account's
        // numeric project/company route in that replacement account.
        if (workspaceId && workspaceId !== result.workspaceId) location.hash = '#/';
        workspaceId = result.workspaceId || null;
        setWorkspaceId(workspaceId);
        rememberWorkspace(userId, workspaceId);
        setAccess(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result);
      } catch {
        if (active) setAccess(previous => previous || { allowed: false, retry: true, error: 'Boardly could not connect. Please try again.' });
      } finally { busy = false; }
    }
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    const timer = setInterval(visible, 3000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      setTokenProvider(null);
      setWorkspaceId(null);
    };
  }, [userId, getToken, selection]);

  function switchWorkspace(id, route = '#/') {
    setAccess(null);
    location.hash = route;
    rememberWorkspace(userId, id);
    setSelection({ id });
  }
  if (!access) return <div className="h-full flex items-center justify-center">Opening your boards…</div>;
  if (!access.allowed) return <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6">
    <h1 className="text-xl font-bold">{access.retry ? 'Connection interrupted' : 'Access is not available for this account'}</h1>
    <p className="text-zinc-400 text-center">{access.error}</p>
    <button className="text-indigo-400" onClick={() => setSelection({ id: selection.id })}>Retry</button>
    <button className="text-indigo-400" onClick={onLogout}>Sign out</button>
  </div>;
  return <Workspace key={userId + access.workspaceId} access={access} onSwitch={switchWorkspace} cloud onLogout={onLogout} profile={profile} onManageProfile={onManageProfile} />;
}
