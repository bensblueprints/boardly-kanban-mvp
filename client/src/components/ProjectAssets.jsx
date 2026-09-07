import React, { useEffect, useRef, useState } from 'react';
import { X, Upload, Link, File, Download, Trash2, ExternalLink, KeyRound, CreditCard } from 'lucide-react';
import { api } from '../api.js';
import ProjectEnvironment from './ProjectEnvironment.jsx';
import ProjectPayments from './ProjectPayments.jsx';
import SshConnections from './SshConnections.jsx';
import GithubConnection from './GithubConnection.jsx';
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export default function ProjectAssets({ board, initialTab = 'files', onClose }) {
  const owner=board.permissions?.owner!==false,readOnly=board.permissions?.role==='viewer';
  const [tab, setTab] = useState(initialTab), [files, setFiles] = useState([]), [links, setLinks] = useState([]);
  const [storage, setStorage] = useState(null), [title, setTitle] = useState(''), [url, setUrl] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = async () => { const [f, l] = await Promise.all([api.get(`/api/boards/${board.id}/files`), api.get(`/api/boards/${board.id}/links`)]); setFiles(f.files); setStorage(f.storage); setLinks(l); };
  useEffect(() => { load().catch(e => setError(e.message)); }, [board.id]);
  const upload = async event => {
    const selected = [...(event.target.files || [])]; if (!selected.length) return;
    setBusy(true); setError('');
    try { for (const file of selected) { const form = new FormData(); form.set('file', file); await api.post(`/api/boards/${board.id}/files`, form); } await load(); }
    catch (e) { setError(e.message); await load().catch(() => {}); } finally { setBusy(false); event.target.value = ''; }
  };
  const save = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/api/boards/${board.id}/${tab === 'files' ? 'file-links' : 'links'}`, { name: title, title, url }); setTitle(''); setUrl(''); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (kind, id) => { try { await api.del(`/api/project-${kind}/${id}`); await load(); } catch (e) { setError(e.message); } };
  return <div className="fixed inset-0 z-50 bg-black/60 p-3 flex items-center justify-center" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={`${board.name} files and links`} onClick={e => e.stopPropagation()} className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-zinc-900 rounded-2xl border border-zinc-700 shadow-2xl">
    <header className="p-5 border-b border-zinc-800 flex items-center justify-between"><h2 className="font-semibold truncate">{board.name}</h2><button aria-label="Close project files and links" onClick={onClose}><X size={20} /></button></header>
    <nav className="p-4 pb-0 flex flex-wrap gap-2">{[['files', File, 'Files'], ['links', Link, 'Links'], ['environment', KeyRound, 'Environment'], ['payments', CreditCard, 'Payments'], ['ssh', KeyRound, 'SSH'], ['github', KeyRound, 'GitHub']].filter(([id])=>owner||['files','links'].includes(id)).map(([id, Icon, label]) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setError(''); }} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm ${tab === id ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400'}`}><Icon size={16} />{label}</button>)}</nav>
    {tab === 'github' ? <div className="p-5"><GithubConnection kind="projects" id={board.id}/></div> : tab === 'ssh' ? <div className="p-5"><SshConnections kind="projects" id={board.id}/></div> : tab === 'payments' ? <div className="p-5"><ProjectPayments board={board} /></div> : tab === 'environment' ? <div className="p-5"><ProjectEnvironment board={board} /></div> :
    <div className="p-5 space-y-5">
      {error && <p role="alert" className="text-rose-300 text-sm">{error}</p>}
      {tab === 'files' && <><div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">Project files</h3><p className="text-xs text-zinc-500 mt-1">{storage && `${bytes(storage.usedBytes)} used across your account · ${storage.unlimited ? 'Unlimited owner storage' : bytes(storage.limitBytes) + ' allowance'}`}</p></div><button disabled={busy||readOnly} onClick={() => input.current?.click()} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm disabled:opacity-50"><Upload size={16} />{busy ? 'Uploading…' : 'Upload files'}</button><input ref={input} type="file" multiple className="hidden" onChange={upload} /></div>
        <p className="text-sm text-zinc-400">Keep source audio, artwork, documents and project outputs here, or link files from another service.</p></>}
      <form hidden={readOnly} onSubmit={save} className="p-4 border border-zinc-700 rounded-xl space-y-3"><h3 className="text-sm font-medium">{tab === 'files' ? 'Link an existing file' : 'Save a project URL'}</h3><div className="flex flex-wrap gap-2"><input aria-label={tab === 'files' ? 'File link name' : 'Link title'} value={title} onChange={e => setTitle(e.target.value)} required maxLength={250} placeholder={tab === 'files' ? 'File name' : 'Title, e.g. Website or GitHub'} className="min-w-0 flex-1 rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-sm" /><input aria-label="URL" type="url" value={url} onChange={e => setUrl(e.target.value)} required placeholder="https://…" className="min-w-0 flex-1 rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-sm" /><button disabled={busy||readOnly} className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm">Add link</button></div></form>
      <div className="space-y-2">{(tab === 'files' ? files : links).length === 0 && <p className="text-sm text-zinc-500 py-5 text-center">{tab === 'files' ? 'No files yet. Upload a file or add a file link.' : 'No links yet. Add the websites and tools used by this project.'}</p>}
        {(tab === 'files' ? files : links).map(item => <div key={item.id} className="flex gap-3 items-center rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><span className="text-zinc-500">{item.url ? <Link size={18} /> : <File size={18} />}</span><div className="flex-1 min-w-0"><p className="text-sm truncate">{item.name || item.title}</p><p className="text-xs text-zinc-500 truncate">{item.url || bytes(item.size)}</p></div><a aria-label={`${item.url ? 'Open' : 'Download'} ${item.name || item.title}`} href={item.url || `/api/project-files/${item.id}/download`} onClick={item.url ? undefined : async e => { e.preventDefault(); try { await api.download(`/api/project-files/${item.id}/download`, item.name); } catch (e) { setError(e.message); } }} target={item.url ? '_blank' : undefined} rel="noopener noreferrer" className="p-2 text-indigo-300 hover:text-indigo-200">{item.url ? <ExternalLink size={16} /> : <Download size={16} />}</a><button hidden={readOnly} aria-label={`Delete ${item.name || item.title}`} onClick={() => remove(tab, item.id)} className="p-2 text-zinc-500 hover:text-rose-300"><Trash2 size={16} /></button></div>)}
      </div>
    </div>}
  </section></div>;
}
