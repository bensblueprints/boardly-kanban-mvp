async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  // An expired session drops the app back to the login screen (cloud mode) —
  // except on the auth endpoints themselves, where 401 is a form error.
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/register')) {
    api.onUnauthorized?.();
  }
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status });
  return json;
}

export const api = {
  get: (url) => req('GET', url),
  post: (url, body) => req('POST', url, body),
  patch: (url, body) => req('PATCH', url, body),
  del: (url) => req('DELETE', url),
  onUnauthorized: null
};
