import React, { useEffect, useRef, useState } from 'react';
import { Upload, File, Folder, FolderPlus, FolderInput, Download, ExternalLink, Link, Trash2, Pencil, ChevronRight } from 'lucide-react';
import { api } from '../api.js';

const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const button = 'flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
const field = 'min-w-0 rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-sm';

export default function ProjectFiles({ board }) {
  const readOnly = board.permissions?.role === 'viewer', uploadInput = useRef(null);
  const [files, setFiles] = useState([]), [folders, setFolders] = useState([]), [storage, setStorage] = useState(null);
  const [folder, setFolder] = useState(null), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState(null), [name, setName] = useState(''), [moving, setMoving] = useState(null), [destination, setDestination] = useState('');
  const [title, setTitle] = useState(''), [url, setUrl] = useState('');
  const base = `/api/boards/${board.id}`;
  async function load() {
    const data = await api.get(base + '/files'); setFiles(data.files); setFolders(data.folders || []); setStorage(data.storage); setReady(true);
    setFolder(current => current !== null && !data.folders?.some(f => f.id === current) ? null : current);
  }
  useEffect(() => { load().catch(e => setError(e.message)); }, [board.id]);
  const current = folders.find(f => f.id === folder), children = folders.filter(f => f.parent_id === folder), visible = files.filter(f => f.folder_id === folder);
  const crumbs = []; let ancestor = current;
  while (ancestor && !crumbs.some(f => f.id === ancestor.id)) { crumbs.unshift(ancestor); ancestor = folders.find(f => f.id === ancestor.parent_id); }
  const navigate = id => { setFolder(id); setEditing(null); setMoving(null); setError(''); };
  async function mutate(action) {
    if (busy || readOnly) return; setBusy(true); setError('');
    try { await action(); await load(); } catch (e) { setError(e.message); await load().catch(() => {}); }
    finally { setBusy(false); }
  }
  const upload = e => {
    const selected = [...(e.target.files || [])]; e.target.value = ''; if (!selected.length) return;
    mutate(async () => { for (const file of selected) { const form = new FormData(); if (folder !== null) form.set('folder_id', String(folder)); form.set('file', file); await api.post(base + '/files', form); } });
  };
  return <div className="p-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="font-medium">Project files</h3>{storage && <p className="text-xs text-zinc-500 mt-1">{bytes(storage.usedBytes)} used across your account · {storage.unlimited ? 'Unlimited owner storage' : bytes(storage.limitBytes) + ' allowance'}</p>}</div>
      <div className="flex flex-wrap gap-2"><button disabled={!ready || busy || readOnly} className={button} onClick={() => { setEditing('new'); setName(''); setMoving(null); }}><FolderPlus size={16} />New folder</button><button disabled={!ready || busy || readOnly} onClick={() => uploadInput.current?.click()} className={button + ' bg-indigo-600 border-indigo-500'}><Upload size={16} />Upload files</button><input ref={uploadInput} aria-label="Upload project files" type="file" multiple hidden onChange={upload} /></div>
    </div>
    <nav aria-label="File folders" className="flex flex-wrap items-center gap-1 text-sm"><button disabled={busy} onClick={() => navigate(null)} className="p-1 text-indigo-300" aria-current={folder === null ? 'page' : undefined}>Files</button>{crumbs.map(f => <React.Fragment key={f.id}><ChevronRight size={14} className="shrink-0 text-zinc-500" /><button disabled={busy} aria-current={f.id === folder ? 'page' : undefined} onClick={() => navigate(f.id)} className="min-w-0 max-w-full break-words p-1 text-indigo-300">{f.name}</button></React.Fragment>)}</nav>
    <p className="text-xs text-zinc-400">Uploads and file links are added to {current ? `“${current.name}”` : 'Files'}. Use Move beside a file to organize it.</p>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    {busy && <p role="status" className="text-xs text-indigo-300">Saving…</p>}
    {current && !readOnly && <div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => { setEditing('rename'); setName(current.name); setMoving(null); }}><Pencil size={14} />Rename folder</button><button disabled={busy || !!children.length || !!visible.length} title="Only empty folders can be deleted" className={button} onClick={() => mutate(async () => { await api.del(`/api/project-folders/${folder}`); navigate(current.parent_id); })}><Trash2 size={14} />Delete empty folder</button></div>}
    {editing && <form aria-label={editing === 'new' ? 'Create folder' : 'Rename folder'} className="rounded-xl border border-zinc-700 p-3 space-y-2" onSubmit={e => { e.preventDefault(); mutate(async () => { if (editing === 'new') { const created = await api.post(base + '/folders', { name, parent_id: folder }); setFolder(created.id); } else await api.patch(`/api/project-folders/${folder}`, { name }); setEditing(null); }); }}><label className="block text-xs text-zinc-400">Folder name<input autoFocus required maxLength={120} aria-label="Folder name" disabled={busy} className={field + ' mt-1 w-full'} value={name} onChange={e => setName(e.target.value)} /></label><div className="flex flex-wrap gap-2"><button disabled={busy || !name.trim()} className={button + ' bg-indigo-600'}>{editing === 'new' ? 'Create folder' : 'Save folder name'}</button><button type="button" disabled={busy} className={button} onClick={() => setEditing(null)}>Cancel</button></div></form>}
    {moving && <form aria-label={`Move ${moving.name}`} className="rounded-xl border border-indigo-700 p-3 space-y-2" onSubmit={e => { e.preventDefault(); mutate(async () => { await api.patch(`/api/project-files/${moving.id}`, { folder_id: destination ? Number(destination) : null }); setMoving(null); }); }}><p className="text-sm break-words">Move {moving.name}</p><label className="block text-xs text-zinc-400">Destination folder<select aria-label="Destination folder" disabled={busy} className={field + ' mt-1 w-full'} value={destination} onChange={e => setDestination(e.target.value)}><option value="">Files (top level)</option>{[...folders].sort((a,b) => a.path.localeCompare(b.path)).map(f => <option key={f.id} value={f.id}>{f.path}</option>)}</select></label><div className="flex gap-2"><button disabled={busy || (destination ? Number(destination) : null) === moving.folder_id} className={button + ' bg-indigo-600'}>Move file</button><button type="button" disabled={busy} onClick={() => setMoving(null)} className={button}>Cancel</button></div></form>}
    <div className="space-y-2" aria-label="Folder contents">
      {children.map(f => <button key={f.id} disabled={busy} aria-label={`Open folder ${f.name}`} onClick={() => navigate(f.id)} className="w-full flex gap-3 items-center rounded-xl border border-zinc-700 bg-zinc-800/40 p-3 text-left hover:bg-zinc-800"><Folder size={20} className="shrink-0 text-indigo-300" /><span className="min-w-0 flex-1"><span className="block text-sm break-words">{f.name}</span><span className="text-xs text-zinc-500">{files.filter(x => x.folder_id === f.id).length} files · {folders.filter(x => x.parent_id === f.id).length} folders</span></span><ChevronRight size={16} className="shrink-0 text-zinc-500" /></button>)}
      {visible.map(item => <div key={item.id} role="group" aria-label={`File ${item.name}`} className="flex flex-wrap gap-2 items-center rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"><span className="shrink-0 text-zinc-500">{item.url ? <Link size={18} /> : <File size={18} />}</span><div className="flex-1 min-w-0"><p className="text-sm break-words">{item.name}</p><p className="text-xs text-zinc-500 truncate">{item.url || bytes(item.size)}</p></div><div className="ml-auto flex items-center gap-1">
        <a aria-label={`${item.url ? 'Open' : 'Download'} ${item.name}`} href={item.url || `/api/project-files/${item.id}/download`} onClick={item.url ? undefined : async e => { e.preventDefault(); try { await api.download(`/api/project-files/${item.id}/download`, item.name); } catch (e) { setError(e.message); } }} target={item.url ? '_blank' : undefined} rel="noopener noreferrer" className="p-2 text-indigo-300">{item.url ? <ExternalLink size={16} /> : <Download size={16} />}</a>
        {!readOnly && <><button disabled={busy} aria-label={`Move ${item.name}`} onClick={() => { setMoving(item); setDestination(item.folder_id === null ? '' : String(item.folder_id)); setEditing(null); }} className="p-2 text-indigo-300 flex items-center gap-1 text-xs"><FolderInput size={16} />Move</button><button disabled={busy} aria-label={`Delete ${item.name}`} onClick={() => mutate(() => api.del(`/api/project-files/${item.id}`))} className="p-2 text-zinc-500 hover:text-rose-300"><Trash2 size={16} /></button></>}
      </div></div>)}
      {ready && !visible.length && !children.length && <p className="py-5 text-center text-sm text-zinc-500">This folder is empty.{!readOnly && ' Upload files, add a file link or create a folder.'}</p>}
    </div>
    {!readOnly && <form onSubmit={e => { e.preventDefault(); mutate(async () => { await api.post(base + '/file-links', { name: title, url, folder_id: folder }); setTitle(''); setUrl(''); }); }} className="p-4 border border-zinc-700 rounded-xl space-y-3"><h3 className="text-sm font-medium">Link an existing file</h3><div className="flex flex-wrap gap-2"><input disabled={busy} aria-label="File link name" required maxLength={250} placeholder="File name" value={title} onChange={e => setTitle(e.target.value)} className={field + ' flex-1'} /><input disabled={busy} aria-label="URL" required type="url" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} className={field + ' flex-1'} /><button disabled={busy} className={button}>Add link</button></div></form>}
  </div>;
}
