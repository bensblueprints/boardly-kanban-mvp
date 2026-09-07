let tokenProvider = null;
let workspaceId=null;
export function setWorkspaceId(id){workspaceId=id;}
export function setTokenProvider(provider) { tokenProvider = provider; }

async function req(method, url, body) {
  const opts = { method, headers: workspaceId?{'x-boardly-workspace':workspaceId}:{} };
  if (tokenProvider) {
    const token = await tokenProvider();
    if (token) opts.headers.authorization = `Bearer ${token}`;
  }
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status });
  return json;
}

export const api = {
  download: async (url, name) => {
    const token = tokenProvider ? await tokenProvider() : null;
    const response = await fetch(url, { headers: {...(token?{authorization:`Bearer ${token}`} : {}),...(workspaceId?{'x-boardly-workspace':workspaceId}:{})} });
    if (!response.ok) throw new Error('File download failed. Try again.');
    const objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = name;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  },
  get: (url) => req('GET', url),
  post: (url, body) => req('POST', url, body),
  put: (url, body) => req('PUT', url, body),
  patch: (url, body) => req('PATCH', url, body),
  del: (url) => req('DELETE', url)
};
