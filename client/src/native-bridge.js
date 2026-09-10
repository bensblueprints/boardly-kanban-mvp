const pending = new Map();
const nonce = crypto.randomUUID();
window.__BOARDLY_NATIVE_DOC = nonce;

window.addEventListener('boardly:native', event => {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.nonce !== nonce || !pending.has(message.id)) return;
  const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
  message.error ? request.reject(new Error(message.error)) : request.resolve(message.data);
});

export function nativeRequest(type, payload = {}) {
  if (window !== window.top || !window.ReactNativeWebView) return Promise.reject(new Error('Open this workspace in the Boardly mobile app.'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The mobile connection timed out. Please reload the workspace.')); }, ['download', 'shareText'].includes(type) ? 180000 : 15000);
    pending.set(id, { resolve, reject, timer });
    window.ReactNativeWebView.postMessage(JSON.stringify({ ...payload, type, id, nonce }));
  });
}

export const nativeToken = () => nativeRequest('token');
