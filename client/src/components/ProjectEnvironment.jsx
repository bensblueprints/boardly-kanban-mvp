import React, { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { api } from '../api.js';

export default function ProjectEnvironment({ board }) {
  const [variables, setVariables] = useState([]), [name, setName] = useState(''), [value, setValue] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const base = `/api/boards/${board.id}/environment`;
  const load = async () => setVariables(await api.get(base));
  useEffect(() => { load().catch(e => setError(e.message)); }, [board.id]);
  const save = async e => {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await api.put(`${base}/${encodeURIComponent(name)}`, { value });
      setNotice(`${name} saved. It will be available to the next agent run.`);
      setName(''); setValue(''); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async name => {
    setBusy(true); setError(''); setNotice('');
    try { await api.del(`${base}/${encodeURIComponent(name)}`); await load(); setNotice(`${name} removed.`); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="space-y-5">
    <div><h3 className="font-medium flex gap-2 items-center"><KeyRound size={18} />Environment variables</h3><p className="mt-2 text-sm text-zinc-400">Store API keys and settings for this project. Values are encrypted and supplied to this project’s agent runs. To change a value, enter its name and save a replacement.</p></div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
    <form onSubmit={save} autoComplete="off" className="p-4 border border-zinc-700 rounded-xl space-y-3">
      <label className="block text-sm">Variable name<input aria-label="Variable name" value={name} onChange={e => setName(e.target.value)} required pattern="[A-Z_][A-Z0-9_]*" maxLength={128} placeholder="SERVICE_API_KEY" spellCheck={false} className="block w-full mt-1 rounded-lg bg-zinc-950 border border-zinc-700 p-2 font-mono text-sm" /></label>
      <label className="block text-sm">Value<input aria-label="Variable value" type="password" autoComplete="new-password" value={value} onChange={e => setValue(e.target.value)} required maxLength={16384} placeholder="Enter a value" className="block w-full mt-1 rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-sm" /></label>
      <button disabled={busy} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm disabled:opacity-50">{busy ? 'Saving…' : variables.some(v => v.name === name) ? 'Replace variable' : 'Save variable'}</button>
    </form>
    <div className="space-y-2">{!variables.length && <p className="text-sm text-zinc-500 py-5 text-center">No environment variables yet.</p>}{variables.map(v => <div key={v.name} className="flex items-center gap-3 rounded-xl border border-zinc-800 p-3"><div className="flex-1 min-w-0"><p className="font-mono text-sm break-all">{v.name}</p><p className="text-xs text-zinc-500">•••••••• · Encrypted</p></div><button disabled={busy} aria-label={`Delete variable ${v.name}`} onClick={() => remove(v.name)} className="p-2 text-zinc-500 hover:text-rose-300"><Trash2 size={16} /></button></div>)}</div>
  </div>;
}
