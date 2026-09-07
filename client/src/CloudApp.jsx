import React, { useEffect, useState } from 'react';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { api, setTokenProvider, setWorkspaceId } from './api.js';
import { Workspace } from './App.jsx';

function CloudSession({ ownerOnly }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { signOut } = useClerk();
  const [access, setAccess] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const isSignUp = /^\/sign-up(\/|$)/.test(location.pathname);
  const needsSignInRoute = isLoaded && !isSignedIn && !/^\/sign-(in|up)(\/|$)/.test(location.pathname);
  useEffect(() => { if (needsSignInRoute) location.replace('/sign-in?redirect_url=' + encodeURIComponent(location.pathname + location.search + location.hash)); }, [needsSignInRoute]);

  useEffect(() => {
    let active = true;
    setAccess(null);
    setTokenProvider(isSignedIn ? getToken : null);
    if (isLoaded && isSignedIn) {
      api.get('/api/me').then(result => { if (active) {setWorkspaceId(result.workspaceId);setAccess(result);} })
        .catch(() => { if (active) setAccess({ allowed: false, retry: true, error: 'Boardly could not connect. Please try again.' }); });
    }
    return () => { active = false; setTokenProvider(null); };
  }, [isLoaded, isSignedIn, userId, getToken, attempt]);

  if (!isLoaded || needsSignInRoute) return <div className="h-full flex items-center justify-center">Loading sign-in…</div>;
  if (!isSignedIn) return <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6">
    <a href="/" className="text-sm text-indigo-300">← Boardly home</a>
    <h1 className="text-2xl font-bold">{isSignUp ? 'Get started with Boardly' : 'Sign in to Boardly'}</h1>
    {isSignUp && !ownerOnly && <p className="text-zinc-400 text-sm">Basic Free · No credit card required</p>}
    {ownerOnly && <p className="text-zinc-400 text-sm">Sign in with the email address added to your company or project.</p>}
    {isSignUp && !ownerOnly
      ? <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/app" />
      : <SignIn routing="path" path="/sign-in" signUpUrl={ownerOnly ? undefined : '/sign-up'} fallbackRedirectUrl="/app" withSignUp={!ownerOnly} transferable={!ownerOnly} />}
  </div>;
  if (!access) return <div className="h-full flex items-center justify-center">Opening your boards…</div>;
  if (!access.allowed) return <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6">
    <h1 className="text-xl font-bold">{access.retry ? 'Connection interrupted' : 'Access is not available for this account'}</h1>
    <p className="text-zinc-400 text-center">{access.error}</p>
    {access.retry && <button className="text-indigo-400" onClick={() => setAttempt(value => value + 1)}>Retry</button>}
    <button className="text-indigo-400" onClick={() => signOut({ redirectUrl: '/' })}>Sign out</button>
  </div>;
  return <Workspace key={userId+access.workspaceId} access={access} onSwitch={id=>{setWorkspaceId(id);location.hash='#/';setAttempt(v=>v+1);}} cloud onLogout={() => signOut({ redirectUrl: '/' })} />;
}

export default function CloudApp({ config }) {
  return <ClerkProvider publishableKey={config.publishableKey} afterSignOutUrl="/" signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app">
    <CloudSession ownerOnly={config.ownerOnly} />
  </ClerkProvider>;
}
