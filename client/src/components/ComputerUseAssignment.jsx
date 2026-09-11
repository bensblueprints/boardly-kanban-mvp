import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
import {ComputerDetails} from './AccountComputerUse.jsx';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export default function ComputerUseAssignment({kind='projects',id,onOpenAccount}){
 const [state,setState]=useState(null),[computers,setComputers]=useState(null),[ids,setIds]=useState([]),[allow,setAllow]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const revision=useRef(0),base=`/api/${kind}/${id}/computeruse`,company=kind==='companies';
 function accept(s){setState(s);setIds(s.rental_ids);setAllow(s.explicit||s.inherited?s.allow_agent&&s.allow_control:true);}
 async function load(){const current=++revision.current,s=await api.get(base);if(current!==revision.current)return;accept(s);if(!s.saved){setComputers(null);return;}const list=await api.get(base+'/rentals');if(current===revision.current)setComputers(list.rentals);}
 useEffect(()=>{setState(null);setComputers(null);setError('');const refresh=()=>load().catch(e=>setError(e.message));refresh();window.addEventListener('boardly-computeruse-changed',refresh);return()=>{revision.current++;window.removeEventListener('boardly-computeruse-changed',refresh);};},[base]);
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}}
 const account=()=>{onOpenAccount?.();location.hash='#/';};
 return <section aria-label={company?'Company computers':'Project computers'} className="rounded-2xl border border-zinc-700 bg-zinc-900/50 p-4 space-y-4">
 <h3 className="font-semibold">{company?'Company computers':'Project computers'}</h3>
 <p className="text-sm text-zinc-400">{company?'Choose computers from your connected account for this company. Its projects and Work agents inherit the assignment.':'Use the company’s computers, or choose a separate assignment for this project.'}</p>
 {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-300">{notice}</p>}
 {state&&<><p className="text-sm text-zinc-400">{state.inherited?'Inherited from company':state.explicit?'Assigned here':'No computers assigned'}{state.rental_ids.length?` · ${state.rental_ids.length} computer(s)`:''}</p>
 {!state.saved?<div className="space-y-3"><p className="text-sm text-amber-200">{state.can_manage_account?'Connect ComputerUse once on the Companies home page.':'Ask the account owner to connect ComputerUse on the Companies home page.'}</p>{state.can_manage_account&&<button className={button} onClick={account}>Connect on Companies home</button>}</div>:<>
 {computers===null?<p className="text-sm text-zinc-400">Loading computers from ComputerUse…</p>:<form className="space-y-3" onSubmit={e=>{e.preventDefault();act(async()=>{await api.put(base,{rental_ids:ids,allow_agent:allow,allow_control:allow});setNotice(ids.length?'Computer assignment saved.':company?'No computers assigned to this company.':'Computer use disabled for this project.');});}}>
 <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="text-sm mb-2">Select computers</legend>{computers.length?computers.map(r=><label className={'flex items-start gap-3 rounded-xl border p-3 text-sm '+(ids.includes(r.id)?'border-indigo-400 bg-indigo-500/10':'border-zinc-700')} key={r.id}><input type="checkbox" className="mt-1" disabled={busy||r.state!=='active'} checked={ids.includes(r.id)} onChange={e=>setIds(e.target.checked?[...ids,r.id]:ids.filter(x=>x!==r.id))}/><span className="min-w-0"><ComputerDetails computer={r}/></span></label>):<p className="text-sm text-zinc-400">No computers in this account yet.</p>}</fieldset>
 {ids.some(id=>!computers.some(r=>r.id===id&&r.state==='active'))&&<p className="text-xs text-amber-200">An assigned computer is no longer active. <button type="button" className="underline" onClick={()=>setIds(ids.filter(id=>computers.some(r=>r.id===id&&r.state==='active')))}>Remove unavailable selections</button></p>}
 <label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={allow} onChange={e=>setAllow(e.target.checked)}/>Allow permitted Work agents to view and control these computers</label>
 <button className={button+' bg-indigo-600'} disabled={busy||ids.some(id=>!computers.some(r=>r.id===id&&r.state==='active'))}>Save assignment</button></form>}
 <div className="flex flex-wrap gap-3"><button disabled={busy} className={button} onClick={()=>act(async()=>{})}>Refresh computers</button>{(state.explicit||!company)&&<button disabled={busy} className={button} onClick={()=>act(async()=>{await api.del(base);setNotice(company?'Company assignment removed.':'Project override removed. The company assignment applies.');})}>{company?'Remove company assignment':'Use company assignment'}</button>}{!company&&<button disabled={busy} className={button} onClick={()=>act(async()=>{await api.put(base,{rental_ids:[],allow_agent:false,allow_control:false});setNotice('Computer use disabled for this project.');})}>Disable for this project</button>}</div>
 </>}</>}
 <p className="text-xs text-zinc-400">One agent controls a computer at a time. Sharing a computer between companies or projects also shares its files and signed-in accounts. Assignments do not create a purchase.</p>
 </section>;
}
