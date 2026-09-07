import React, { useEffect } from 'react';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import WorkspaceSession from './WorkspaceSession.jsx';

function CloudSession({ ownerOnly }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { signOut } = useClerk();
  const isSignUp = /^\/sign-up(\/|$)/.test(location.pathname);
  const needsSignInRoute = isLoaded && !isSignedIn && !/^\/sign-(in|up)(\/|$)/.test(location.pathname);
  useEffect(() => { if (needsSignInRoute) location.replace('/sign-in?redirect_url=' + encodeURIComponent(location.pathname + location.search + location.hash)); }, [needsSignInRoute]);

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
  return <WorkspaceSession key={userId} userId={userId} getToken={getToken} onLogout={() => signOut({ redirectUrl: '/' })} />;
}

export default function CloudApp({ config }) {
  return <ClerkProvider publishableKey={config.publishableKey} afterSignOutUrl="/" signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app">
    <CloudSession ownerOnly={config.ownerOnly} />
  </ClerkProvider>;
}
