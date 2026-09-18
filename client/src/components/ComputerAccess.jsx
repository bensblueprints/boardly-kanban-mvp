import React,{useState} from 'react';
export default function ComputerAccess({connection,members,busy,onSave}){
 const [draft,setDraft]=useState(null),value=draft||connection.access||{mode:'shared',member_ids:[]};
 return <div className="rounded-lg border border-zinc-700 p-3 space-y-2">
  <label className="block text-sm">{connection.label}
   <select aria-label={'Who can use '+connection.label} disabled={busy} className="block mt-2 rounded-lg bg-zinc-950 border border-zinc-700 p-2" value={value.mode} onChange={e=>setDraft({...value,mode:e.target.value})}>
    <option value="shared">Shared with permitted workspace members</option><option value="owner">Account owner only</option><option value="assigned">Assign to selected members</option>
   </select>
  </label>
  {value.mode==='assigned'&&<div className="space-y-2">{members.length?members.map(m=><label key={m.id} className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={value.member_ids.includes(m.id)} onChange={e=>setDraft({...value,member_ids:e.target.checked?[...value.member_ids,m.id]:value.member_ids.filter(id=>id!==m.id)})}/>{m.name||m.email}{m.name?' · '+m.email:''}</label>):<p className="text-xs text-amber-200">Add a member through a company or project first.</p>}</div>}
  {draft&&<button disabled={busy||(value.mode==='assigned'&&!value.member_ids.length)} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40" onClick={()=>onSave(value).then(ok=>{if(ok!==false)setDraft(null);})}>Save computer access</button>}
 </div>;
}
