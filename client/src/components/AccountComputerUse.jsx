import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export default function AccountComputerUse({focus=false}){
 const [state,setState]=useState(null),[token,setToken]=useState(''),[rentals,setRentals]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const heading=useRef(null),base='/api/account/computeruse';
 const load=()=>api.get(base).then(setState);
 useEffect(()=>{load().catch(e=>setError(e.message));if(focus)heading.current?.scrollIntoView({block:'center'});},[focus]);
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();await load();}catch(e){setError(e.message);await load().catch(()=>{});}finally{setBusy(false);}}
 return <section aria-label="Account ComputerUse" className="border-t border-zinc-700 pt-5 space-y-4"><h3 ref={heading} className="font-semibold">ComputerUse account</h3>
 <p className="text-sm text-zinc-400">Connect once, then assign one or more rented computers in Company → Computers or Project → Computer use. A company assignment is inherited by its projects.</p>
 {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-300">{notice}</p>}
 {state&&!state.configured?<p className="text-sm text-amber-200">The ComputerUse service connection is being prepared.</p>:state&&<>
 <p className={'text-sm '+(state.saved?'text-emerald-300':'text-zinc-400')}>{state.saved?'ComputerUse API key saved':'No ComputerUse API key saved'}</p>
 <form className="space-y-3" onSubmit={e=>{e.preventDefault();act(async()=>{await api.put(base,{token});setToken('');setRentals(null);setNotice('Account verified. Assign your active rentals to a company or project.');});}}>
 <label className="block text-sm">ComputerUse API key<input type="password" autoComplete="new-password" spellCheck={false} required minLength={16} maxLength={256} value={token} onChange={e=>setToken(e.target.value)} className="block mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3"/></label>
 <p className="text-xs text-zinc-400">Create an account:read key in ComputerUse. It is encrypted on the server and excluded from agent prompts. {state.saved&&'Replacing the key clears current computer assignments.'}</p>
 <button className={button+' bg-indigo-600'} disabled={busy||token.length<16}>{busy?'Verifying…':state.saved?'Replace API key':'Connect ComputerUse'}</button></form>
 {state.saved&&<div className="flex flex-wrap gap-3"><button disabled={busy} className={button} onClick={()=>act(async()=>{setRentals((await api.get(base+'/rentals')).rentals);})}>Check my rentals</button><button disabled={busy} className={button} onClick={()=>{if(window.confirm('Disconnect ComputerUse and clear its company and project assignments? Your rentals and billing at ComputerUse will continue.'))act(async()=>{await api.del(base);setToken('');setRentals(null);setNotice('Boardly connection and assignments removed.');});}}>Disconnect</button></div>}
 {rentals&&<div className="text-sm text-zinc-400">{rentals.length?rentals.map(r=><p key={r.id}>{r.plan==='creator'?'16 GB Creator':'8 GB Standard'} · {r.id} · {r.state}</p>):'No rentals yet. Rentals appear here after ComputerUse activates them.'}</div>}</>}
 <p className="text-sm"><a className="text-indigo-300 underline" href="https://computeruse.space/portal/" target="_blank" rel="noopener noreferrer">Open ComputerUse account</a> · <a className="text-indigo-300 underline" href="https://computeruse.space/download/" target="_blank" rel="noopener noreferrer">Download worker setup</a></p>
 <p className="text-xs text-zinc-400">8 GB Standard: $24.99 / 30 days. 16 GB Creator: $39.99 / 30 days. Per computer, subject to availability; AI usage is separate. Desktop control is awaiting the worker desktop service.</p></section>;
}
