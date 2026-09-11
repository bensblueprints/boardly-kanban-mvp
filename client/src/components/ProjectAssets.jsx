import React, { useEffect, useState } from 'react';
import { X, Link, File, Trash2, ExternalLink, KeyRound, CreditCard } from 'lucide-react';
import { api } from '../api.js';
import ProjectFiles from './ProjectFiles.jsx';
import ProjectEnvironment from './ProjectEnvironment.jsx';
import ProjectPayments from './ProjectPayments.jsx';
import SshConnections from './SshConnections.jsx';
import GithubConnection from './GithubConnection.jsx';

export default function ProjectAssets({ board, initialTab = 'files', onClose }) {
  const owner=board.permissions?.owner!==false,readOnly=board.permissions?.role==='viewer';
  const allowed=id=>owner||['files','links'].includes(id)||board.permissions?.scopes?.includes(id);
  const [requestedTab, setTab] = useState(initialTab), [links, setLinks] = useState([]);
  const tab=allowed(requestedTab)?requestedTab:'files';
  const [title, setTitle] = useState(''), [url, setUrl] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => setLinks(await api.get(`/api/boards/${board.id}/links`));
  useEffect(() => { load().catch(e => setError(e.message)); }, [board.id]);
  const save = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/api/boards/${board.id}/links`, { title, url }); setTitle(''); setUrl(''); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (kind, id) => { try { await api.del(`/api/project-${kind}/${id}`); await load(); } catch (e) { setError(e.message); } };
  return <div className="fixed inset-0 z-50 bg-black/60 p-3 flex items-center justify-center" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={`${board.name} files and links`} onClick={e => e.stopPropagation()} className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-zinc-900 rounded-2xl border border-zinc-700 shadow-2xl">
    <header className="p-5 border-b border-zinc-800 flex items-center justify-between"><h2 className="font-semibold truncate">{board.name}</h2><button aria-label="Close project files and links" onClick={onClose}><X size={20} /></button></header>
    <nav className="p-4 pb-0 flex flex-wrap gap-2">{[['files', File, 'Files'], ['links', Link, 'Links'], ['environment', KeyRound, 'Environment'], ['payments', CreditCard, 'Payments'], ['ssh', KeyRound, 'SSH'], ['github', KeyRound, 'GitHub']].filter(([id])=>['files','links'].includes(id)).map(([id, Icon, label]) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setError(''); }} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm ${tab === id ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400'}`}><Icon size={16} />{label}</button>)}</nav>
    {tab === 'files' ? <ProjectFiles key={board.id} board={board} /> : tab === 'github' ? <div className="p-5"><GithubConnection kind="projects" id={board.id}/></div> : tab === 'ssh' ? <div className="p-5"><SshConnections kind="projects" id={board.id}/></div> : tab === 'payments' ? <div className="p-5"><ProjectPayments board={board} /></div> : tab === 'environment' ? <div className="p-5"><ProjectEnvironment board={board} /></div> :
    <div className="p-5 space-y-5">
      {error && <p role="alert" className="text-rose-300 text-sm">{error}</p>}
      <form hidden={readOnly} onSubmit={save} className="p-4 border border-zinc-700 rounded-xl space-y-3"><h3 className="text-sm font-medium">Save a project URL</h3><div className="flex flex-wrap gap-2"><input aria-label="Link title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={250} placeholder="Title, e.g. Website or GitHub" className="min-w-0 flex-1 rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-sm" /><input aria-label="URL" type="url" value={url} onChange={e => setUrl(e.target.value)} required placeholder="https://…" className="min-w-0 flex-1 rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-sm" /><button disabled={busy||readOnly} className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm">Add link</button></div></form>
      <div className="space-y-2">{links.length === 0 && <p className="text-sm text-zinc-500 py-5 text-center">No links yet. Add the websites and tools used by this project.</p>}
        {links.map(item => <div key={item.id} className="flex gap-3 items-center rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><span className="text-zinc-500">{item.url ? <Link size={18} /> : <File size={18} />}</span><div className="flex-1 min-w-0"><p className="text-sm truncate">{item.title}</p><p className="text-xs text-zinc-500 truncate">{item.url}</p></div><a aria-label={`Open ${item.title}`} href={item.url} target="_blank" rel="noopener noreferrer" className="p-2 text-indigo-300 hover:text-indigo-200"><ExternalLink size={16} /></a><button hidden={readOnly} aria-label={`Delete ${item.title}`} onClick={() => remove(tab, item.id)} className="p-2 text-zinc-500 hover:text-rose-300"><Trash2 size={16} /></button></div>)}
      </div>
    </div>}
  </section></div>;
}
