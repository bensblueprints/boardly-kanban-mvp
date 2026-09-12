let tokenProvider = null;
let downloadProvider = null;
export function setDownloadProvider(provider) { downloadProvider = provider; }
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
  let res;
  for(let attempt=0;attempt<4;attempt++){
    try{res=await fetch(url,opts);}catch(error){if(method!=='GET'||attempt===3)throw new Error('Boardly could not be reached. Check your connection and refresh. If you submitted a change, check its status before retrying.');}
    if(res&&(![502,503,504].includes(res.status)||method!=='GET'||attempt===3))break;
    await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status });
  return json;
}

export const api = {
  blob: async (url, signal) => {
    const token = tokenProvider ? await tokenProvider() : null;
    const response = await fetch(url, { signal, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(workspaceId ? { 'x-boardly-workspace': workspaceId } : {}) } });
    if (!response.ok) throw new Error('File could not be loaded.');
    return response.blob();
  },
  saveText: async (content, name) => {
    if (downloadProvider) return downloadProvider(null, name, workspaceId, content);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  audio: async (url, body, signal) => {
    const token = tokenProvider ? await tokenProvider() : null;
    const response = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(workspaceId ? { 'x-boardly-workspace': workspaceId } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw Object.assign(new Error(data.error || 'Audio could not be loaded.'), { status: response.status }); }
    return response.blob();
  },
  download: async (url, name) => {
    if (downloadProvider) return downloadProvider(url, name, workspaceId);
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
  del: (url, body) => req('DELETE', url, body)
};
