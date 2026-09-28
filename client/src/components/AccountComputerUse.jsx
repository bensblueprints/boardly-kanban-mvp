import React,{useEffect,useRef,useState} from 'react';
import {Monitor,PlugZap} from 'lucide-react';
import {api} from '../api.js';
import ComputerVisionSettings from './ComputerVisionSettings.jsx';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export function ComputerDetails({computer:r}){
 return <><span className="block font-medium text-zinc-100">{r.label||(r.plan==='creator'?'Creator desktop':'Standard desktop')}</span><span className="block text-xs text-zinc-400 mt-1">{r.kind==='pilot'?'Free Desktop':'Rental'} · {r.available===true?'Online':r.available===false?'Offline':'Awaiting desktop'}{Number.isSafeInteger(r.memory_mib)?` · ${r.memory_mib/1024} GB desktop RAM`:''}{Number.isSafeInteger(r.vcpus)?` · ${r.vcpus} vCPU`:''}</span></>;
}
export default function AccountComputerUse({focus=false,home=false,companies=[],onCompany}){
 const [state,setState]=useState(null),[token,setToken]=useState(''),[computers,setComputers]=useState(null),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false),[company,setCompany]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const heading=useRef(null),revision=useRef(0),base='/api/account/computeruse';
 async function load(){const current=++revision.current;const s=await api.get(base);if(current!==revision.current)return;setState(s);if(!s.saved){setComputers(null);return;}const list=await api.get(base+'/rentals');if(current===revision.current)setComputers(list.rentals);}
 useEffect(()=>{const refresh=()=>load().catch(e=>setError(e.message));refresh();window.addEventListener('boardly-computeruse-changed',refresh);return()=>{revision.current++;window.removeEventListener('boardly-computeruse-changed',refresh);};},[]);
 useEffect(()=>{if(focus)heading.current?.scrollIntoView({block:'center'});},[focus]);
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();await load();window.dispatchEvent(new Event('boardly-computeruse-changed'));}catch(e){setError(e.message);await load().catch(()=>{});}finally{setBusy(false);}}
 return <section aria-label="Account ComputerUse" className={home?'rounded-2xl border border-indigo-500/30 bg-zinc-900 p-5 space-y-4':'border-t border-zinc-700 pt-5 space-y-4'}>
 <div className="flex flex-wrap items-center justify-between gap-3"><h3 ref={heading} className="font-semibold flex items-center gap-2"><Monitor size={20} className="text-indigo-300"/>{home?'ComputerUse':'ComputerUse account'}</h3>{state?.saved&&<span className="text-xs text-emerald-300 flex items-center gap-1"><PlugZap size={14}/>API connected</span>}</div>
 <p className="text-sm text-zinc-400">Connect your account once. Its computers are available to assign inside any company. Each company chooses its computers, and its projects inherit that selection.</p>
 {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-300">{notice}</p>}
 {state&&!state.configured?<p className="text-sm text-amber-200">The ComputerUse service connection is being prepared.</p>:state&&<>
 {state.saved&&<><div aria-label="Account computers" className="grid gap-3 sm:grid-cols-2">{computers===null?<p className="text-sm text-zinc-400">Loading computers from ComputerUse…</p>:computers.length?computers.map(r=><article key={r.id} className="rounded-xl border border-zinc-700 p-3"><ComputerDetails computer={r}/></article>):<p className="text-sm text-zinc-400">No computers in this account yet. Free Desktops and rentals appear automatically from ComputerUse.</p>}</div>
 {home&&companies.length>0&&<div className="flex flex-wrap items-end gap-2"><label className="text-sm text-zinc-300">Assign computers in a company<select aria-label="Company for computer assignment" className="block mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2" value={company} onChange={e=>setCompany(e.target.value)}><option value="">Choose a company</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className={button} disabled={!company} onClick={()=>onCompany?.(Number(company))}>Open company</button></div>}
 <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={()=>act(async()=>{})}>Refresh computers</button><button className={button} disabled={busy} onClick={()=>{setToken('');setEditing(!editing);}}>{editing?'Close connection settings':'Manage API connection'}</button></div></>}
 {(!state.saved||editing)&&<><form className="space-y-3" onSubmit={e=>{e.preventDefault();act(async()=>{await api.put(base,{token});setToken('');setEditing(false);setNotice('ComputerUse connected. Open a company to assign its computers.');});}}>
 <label className="block text-sm">ComputerUse API key<input type="password" autoComplete="new-password" spellCheck={false} required minLength={16} maxLength={256} value={token} onChange={e=>setToken(e.target.value)} className="block mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3"/></label>
 <p className="text-xs text-zinc-400">Use a key with account:read, desktop:read and desktop:write permissions. It stays encrypted on the server. {state.saved&&'Replacing the key clears current computer assignments.'}</p>
 <button className={button+' bg-indigo-600'} disabled={busy||token.length<16}>{busy?'Connecting…':state.saved?'Replace API key':'Connect ComputerUse'}</button></form>
 {state.saved&&<button disabled={busy} className={button} onClick={()=>{if(window.confirm('Disconnect ComputerUse and clear its company and project assignments? Your ComputerUse account and billing will continue.'))act(async()=>{await api.del(base);setToken('');setEditing(false);setNotice('ComputerUse disconnected.');});}}>Disconnect ComputerUse</button>}</>}
 </>}
 {state?.saved&&<ComputerVisionSettings/>}
 <p className="text-xs text-zinc-400">Inventory comes from your ComputerUse API. Assigning an existing computer in Boardly does not buy another rental.</p>
 <a className="text-sm text-indigo-300 underline" href="https://computeruse.space/portal" target="_blank" rel="noopener noreferrer">Manage computers at ComputerUse</a>
 </section>;
}
