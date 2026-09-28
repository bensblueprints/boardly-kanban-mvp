export const ORIGIN = process.env.EXPO_PUBLIC_BOARDLY_ORIGIN || 'https://boardlyagent.com';
export const PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || '';
if (new URL(ORIGIN).origin !== ORIGIN || !ORIGIN.startsWith('https://')) throw new Error('Boardly requires a secure server origin.');
export function isWorkspaceUrl(value: string) {
  try { const url = new URL(value); return url.origin === ORIGIN && url.pathname === '/mobile/'; } catch { return false; }
}
export function downloadUrl(value: string) {
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || !(/^\/api\/project-files\/\d+\/download$/.test(url.pathname) || /^\/api\/boards\/\d+\/export$/.test(url.pathname) || /^\/uploads\/[^/]+$/.test(url.pathname))) throw new Error('This download is not a Boardly file.');
  return url.href;
}
