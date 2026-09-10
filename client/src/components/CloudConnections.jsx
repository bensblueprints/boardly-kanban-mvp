import React, { useEffect, useState } from 'react';
import { X, Copy, Download, Plug, Cloud, Trash2, Check } from 'lucide-react';
import { api } from '../api.js';

const release = 'https://github.com/bensblueprints/boardly-kanban-mvp/releases/download/v1.9.0/';
export const desktopDownloads = [
  ['Windows', 'Windows installer', release + 'Boardly.Setup.1.9.0.exe'],
  ['Mac', 'Apple Silicon · macOS', release + 'Boardly-1.9.0-arm64.dmg'],
  ['Linux', 'AppImage · x64', release + 'Boardly-1.9.0.AppImage'],
  ['Linux', 'Debian / Ubuntu · x64', release + 'boardly_1.9.0_amd64.deb'],
];

function CopyField({ label, value, multiline = false }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  return <div className="space-y-1.5">
    <label className="text-xs font-semibold text-zinc-400">{label}</label>
    <div className="flex gap-2 items-start">
      {multiline ? <textarea readOnly aria-label={label} value={value} rows={6} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs" />
        : <input readOnly aria-label={label} value={value} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-xs" />}
      <button aria-label={`Copy ${label}`} className="p-3 rounded-lg bg-zinc-800 hover:bg-zinc-700" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setError(''); setTimeout(() => setCopied(false), 2000); }
        catch { setError('Select the text and copy it manually.'); }
      }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
    </div>{error && <p className="text-xs text-amber-300">{error}</p>}
  </div>;
}

export default function CloudConnections({ initialTab = 'mcp', onClose }) {
  const [tab, setTab] = useState(initialTab), [connections, setConnections] = useState([]);
  const [origin, setOrigin] = useState(location.origin), [name, setName] = useState('');
  const [issued, setIssued] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => { const d = await api.get('/api/connections'); setConnections(d.connections); setOrigin(d.origin); };
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  useEffect(() => { const f = e => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [onClose]);
  const create = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { const d = await api.post('/api/connections', { name: name.trim() || (tab === 'mcp' ? 'My AI client' : 'My desktop'), scope: tab }); setIssued(d); setName(''); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const current = issued?.scope === tab ? issued : null;
  return <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-3" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="Boardly connections and downloads" onClick={e => e.stopPropagation()} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      <header className="flex items-center justify-between p-5 border-b border-zinc-800"><h2 className="font-semibold text-lg">Connect your workspace</h2><button aria-label="Close connections" onClick={onClose}><X size={20} /></button></header>
      <nav className="flex gap-2 px-5 pt-4" aria-label="Connection type">
        {[["mcp", 'MCP connector', Plug], ['sync', 'Desktop sync', Cloud], ['downloads', 'Download apps', Download]].map(([id, title, Icon]) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setError(''); }} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${tab === id ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:bg-zinc-800'}`}><Icon size={16} />{title}</button>)}
      </nav>
      <div className="p-5 space-y-5">
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        {tab === 'downloads' ? <>
          <div><h3 className="font-semibold">Boardly for your desktop</h3><p className="text-sm text-zinc-400 mt-1">Keep a local copy of your boards and sync with your cloud workspace.</p></div>
          <div className="grid sm:grid-cols-2 gap-3">{desktopDownloads.map(([platform, detail, href]) => <a key={href} href={href} className="p-4 rounded-xl border border-zinc-700 hover:border-indigo-400 flex gap-3 items-center"><Download size={22} className="text-indigo-300" /><span><strong className="block">{platform}</strong><span className="text-xs text-zinc-400">{detail} · v1.9.0</span></span></a>)}</div>
          <p className="text-sm text-zinc-400">After installing, open <strong className="text-zinc-200">Sync</strong> in the desktop app. Create a desktop key here, then paste the server address and key into the app’s existing-token form.</p>
          <button onClick={() => setTab('sync')} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm">Connect a desktop</button>
        </> : <>
          <div><h3 className="font-semibold">{tab === 'mcp' ? 'Let your AI client work with Boardly' : 'Sync this account with your desktop'}</h3>
            <p className="text-sm text-zinc-400 mt-1">{tab === 'mcp' ? 'Connect a client that supports Streamable HTTP and a Bearer token. It will use the same boards you see here.' : 'Use a separate key for each computer. Changes to boards, cards, checklists and attachments sync both ways.'}</p></div>
          <CopyField label={tab === 'mcp' ? 'MCP server URL' : 'Sync server URL'} value={origin + (tab === 'mcp' ? '/mcp' : '')} />
          <form onSubmit={create} className="flex gap-2"><input aria-label="Connection name" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder={tab === 'mcp' ? 'Connection name, e.g. Codex' : 'Computer name, e.g. Ben’s laptop'} className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm" /><button disabled={busy} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 text-sm disabled:opacity-50">{busy ? 'Creating…' : 'Create key'}</button></form>
          {current && <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/5 p-4 space-y-3">
            <p className="text-sm text-indigo-200">Key created. Copy it now; it is shown only once. You can revoke it below.</p>
            <CopyField label="Connection key" value={current.token} />
            {tab === 'mcp' && <details><summary className="cursor-pointer text-sm text-zinc-300">Client configuration</summary><div className="mt-3 space-y-3">
              <CopyField label="JSON configuration" multiline value={JSON.stringify({ mcpServers: { boardly: { url: origin + '/mcp', headers: { Authorization: 'Bearer ' + current.token } } } }, null, 2)} />
              <CopyField label="Codex configuration" multiline value={'[mcp_servers.boardly]\nurl = "' + origin + '/mcp"\nbearer_token_env_var = "BOARDLY_MCP_TOKEN"'} />
              <p className="text-xs text-zinc-400">For Codex, save the key as BOARDLY_MCP_TOKEN in the environment used to launch Codex.</p>
            </div></details>}
          </div>}
          {tab === 'sync' && <ol className="list-decimal ml-5 space-y-2 text-sm text-zinc-400"><li><button className="text-indigo-300 underline" onClick={() => setTab('downloads')}>Download and open Boardly desktop.</button></li><li>Open Sync, then the existing-token form.</li><li>Replace the server URL with the address above, paste your desktop key and connect.</li><li>Click Sync now, then return to your boards. Existing local boards are merged by their identifiers.</li></ol>}
          <div><h4 className="text-sm font-semibold mb-2">Your {tab === 'mcp' ? 'MCP connections' : 'desktops'}</h4>
            {connections.filter(c => c.scope === tab && !c.revoked_at).length === 0 && <p className="text-sm text-zinc-500">No connections yet.</p>}
            {connections.filter(c => c.scope === tab && !c.revoked_at).map(c => <div key={c.id} className="flex justify-between gap-3 py-3 border-b border-zinc-800"><div><p className="text-sm">{c.name}</p><p className="text-xs text-zinc-500">{c.last_used_at ? 'Last connected ' + new Date(c.last_used_at).toLocaleString() : 'Waiting for first connection'} · Expires {new Date(c.expires_at).toLocaleDateString()}</p></div><button aria-label={`Revoke ${c.name}`} className="text-zinc-400 hover:text-rose-300" onClick={async () => { try { await api.del('/api/connections/' + c.id); if (issued?.id === c.id) setIssued(null); await load(); } catch (e) { setError(e.message); } }}><Trash2 size={16} /></button></div>)}
          </div>
        </>}
      </div>
    </section>
  </div>;
}
