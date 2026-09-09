import React, { useEffect, useRef, useState } from 'react';
import { Monitor, X } from 'lucide-react';
import { api } from '../api.js';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export default function ProjectComputers({ board, onClose }) {
  const dialog=useRef(null),[data,setData]=useState(null),[quantity,setQuantity]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const base=`/api/boards/${board.id}/computers`;
  useEffect(()=>{const el=dialog.current;el.showModal();return()=>el.close();},[]);
  useEffect(()=>{let alive=true;api.get(base).then(value=>{if(alive){setData(value);setQuantity(value.request?.quantity||1);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[base]);
  async function save(cancel=false){if(busy)return;setBusy(true);setError('');try{setData(await (cancel?api.del(base+'/request'):api.put(base+'/request',{quantity})));}catch(e){setError(e.message);}finally{setBusy(false);}}
  const plan=data?.plan,total=plan?new Intl.NumberFormat('en-US',{style:'currency',currency:plan.currency}).format(plan.monthly_cents*quantity/100):'';
  return <dialog ref={dialog} aria-label={`Computer use for ${board.name}`} onCancel={e=>{e.preventDefault();onClose();}} className="m-auto w-[calc(100%-24px)] max-w-xl max-h-[90dvh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 text-zinc-100 p-0 backdrop:bg-black/70">
    <header className="flex items-center gap-3 border-b border-zinc-800 p-5"><Monitor className="shrink-0 text-indigo-300"/><div className="min-w-0 flex-1"><h2 className="font-semibold">Computer use</h2><p className="text-xs text-zinc-400 break-words">{board.name}</p></div><button className={button} aria-label="Close computer use" onClick={onClose}><X size={16}/></button></header>
    <div className="p-5 space-y-4">{error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{!data&&!error&&<p>Loading…</p>}{plan&&<>
      <span className="inline-block rounded-full bg-amber-500/10 px-3 py-1 text-xs text-amber-200">Coming soon · Hardware being prepared</span>
      <p className="text-3xl font-semibold">$29.99 <span className="text-sm font-normal text-zinc-400">per month, per computer</span></p>
      <div className="grid grid-cols-2 gap-3"><div className="rounded-xl border border-zinc-800 p-4"><p className="font-medium">{plan.ram_gb} GB RAM</p><p className="text-xs text-zinc-400">Per computer</p></div><div className="rounded-xl border border-zinc-800 p-4"><p className="font-medium">{plan.storage_gb} GB storage</p><p className="text-xs text-zinc-400">Per computer</p></div></div>
      <p className="text-sm text-zinc-300">A private computer for this project’s browser and desktop work. Computer access will open after the hardware and service are ready.</p>
      <p className="text-xs text-zinc-400">AI usage follows your account’s AI settings and is separate from the computer subscription.</p>
      {data.request&&<div role="status" className="rounded-xl border border-indigo-700 bg-indigo-500/10 p-3 text-sm">Availability requested for {data.request.quantity} {data.request.quantity===1?'computer':'computers'}. Awaiting availability. This is not a subscription.</div>}
      {data.can_request?<form className="space-y-3" onSubmit={e=>{e.preventDefault();save();}}><label className="block text-sm">Number of computers<input aria-label="Number of computers" type="number" min={1} max={32} step={1} required disabled={busy} value={quantity} onChange={e=>setQuantity(e.target.value===''?'':Number(e.target.value))} className="block w-full mt-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2"/></label><p className="text-sm text-zinc-300">Planned monthly total: {Number.isInteger(quantity)&&quantity>0?total:'—'}</p><div className="flex flex-wrap gap-2"><button disabled={busy||!Number.isInteger(quantity)||quantity<1||quantity>32} className={button+' bg-indigo-600 border-indigo-500'}>{busy?'Saving…':data.request?'Update request':'Request availability'}</button>{data.request&&<button type="button" disabled={busy} className={button} onClick={()=>save(true)}>Cancel request</button>}</div><p className="text-xs text-zinc-400">No payment is taken. You’ll confirm the subscription when computers become available.</p></form>:<p className="text-sm text-zinc-400">The account owner manages computer requests and subscriptions.</p>}
    </>}</div>
  </dialog>;
}
