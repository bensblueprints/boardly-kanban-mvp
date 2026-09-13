import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
const input = 'rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm';
export default function Members({ kind, id, onClose, embedded=false }) {
 const [data,setData]=useState(null),[email,setEmail]=useState(''),[role,setRole]=useState('editor');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState({});
 const requestId=useRef(0),writing=useRef(false);
 const base=`/api/${kind}/${id}/members`;
 const load=async()=>{const id=++requestId.current;const next=await api.get(base);if(id===requestId.current)setData(next);};
 useEffect(()=>{
  let active=true,pending=false;
  const refresh=async()=>{if(pending||!active||writing.current)return;pending=true;const id=++requestId.current;try{const next=await api.get(base);if(active&&id===requestId.current){setData(next);setError('');}}catch(e){if(active&&id===requestId.current){setError(e.message);if(e.status===403||e.status===404)setData(null);}}finally{pending=false;}};
  const visible=()=>{if(document.visibilityState==='visible')refresh();};
  refresh();const timer=setInterval(visible,3000);window.addEventListener('focus',refresh);
  return()=>{active=false;requestId.current++;clearInterval(timer);window.removeEventListener('focus',refresh);};
 },[base]);
 useEffect(()=>{if(data?.allowed_roles&&!data.allowed_roles.includes(role))setRole(data.allowed_roles[0]);},[data,role]);
 async function act(fn){writing.current=true;requestId.current++;setBusy(true);setError('');try{await fn();await load();}catch(e){await load().catch(()=>{});setError(e.message);}finally{writing.current=false;setBusy(false);}}
 function changeScope(m,scope,enabled){const scopes=enabled?[...(m.scopes||[]),scope.id]:(m.scopes||[]).filter(id=>id!==scope.id);setData(previous=>Object.fromEntries(Object.entries(previous).map(([key,value])=>[key,['members','inherited','project_members'].includes(key)?value.map(row=>row.grant_id===m.grant_id?{...row,scopes}:row):value])));act(async()=>{await api.patch(`/api/memberships/${m.grant_id}`,{scopes});setNotice(`${scope.name} access ${enabled?'enabled':'disabled'} for ${m.email}.`);});}
 function changeOwnerSsh(m,enabled){setData(previous=>Object.fromEntries(Object.entries(previous).map(([key,value])=>[key,['members','inherited','project_members'].includes(key)?value.map(row=>row.id===m.id?{...row,owner_ssh:Number(enabled)}:row):value])));act(async()=>{await api.patch(`/api/memberships/${m.grant_id}`,{owner_ssh:enabled});setNotice(`SSH across your companies ${enabled?'enabled':'disabled'} for ${m.email}.`);});}
 function memberRow(m, inherited=false){
  const label=m.project_name?`${m.email} · ${m.project_name}`:m.email;
  const canEdit=m.can_manage!==false&&!inherited;
  return <section key={m.grant_id} aria-label={label} className="rounded-xl border border-zinc-800 p-4 space-y-3">
   <div className="flex flex-wrap items-center gap-3"><div className="flex-1 min-w-40"><p className="text-sm break-all">{m.email}</p><p className="text-xs text-zinc-500 mt-1">{m.project_name?`Project: ${m.project_name}`:m.inherited_from?`Inherited from ${m.inherited_from}`:kind==='companies'?'Company member':'Project member'} · {m.status==='active'?'Active':'Awaiting first sign-in'}</p></div>
    {canEdit?<><select aria-label={`Role for ${label}`} value={m.role} disabled={busy} className={input} onChange={e=>act(()=>api.patch(`/api/memberships/${m.grant_id}`,{role:e.target.value}))}>{(data.allowed_roles||['editor','viewer']).map(value=><option key={value} value={value}>{value==='editor'?'Editor':'Viewer'}</option>)}</select><button disabled={busy} className="text-sm text-rose-300 disabled:opacity-50" onClick={()=>act(()=>api.del(`/api/memberships/${m.grant_id}`))}>Remove</button></>:<span className="text-sm capitalize text-zinc-400">{m.role}</span>}
   </div>
   <div className="flex flex-wrap justify-between items-center gap-2"><p className="text-xs text-zinc-400">{m.scopes?.length?`Extra access: ${data.scope_catalog.filter(s=>m.scopes.includes(s.id)).map(s=>s.name).join(', ')}`:'No extra permission scopes'}</p>{data.can_manage_scopes&&!inherited&&<button type="button" aria-expanded={!!expanded[m.grant_id]} className="text-sm text-indigo-300" onClick={()=>setExpanded(old=>({...old,[m.grant_id]:!old[m.grant_id]}))}>Permission scopes</button>}</div>
   {m.owner_ssh===1&&<p className="text-xs text-indigo-300">SSH enabled across this owner’s companies where this member has access.</p>}
   {m.scopes_need_review&&<p className="text-sm text-amber-300">This project changed companies. Its extra scopes are inactive until the owner reviews and saves them for this company.</p>}
   {expanded[m.grant_id]&&data.can_manage_scopes&&!inherited&&<fieldset disabled={busy} className="border-t border-zinc-800 pt-3 space-y-3"><legend className="text-xs text-zinc-400 px-1">{m.kind==='company'?'Applies to this company and its projects':'Applies to this project only'}</legend>
    {data.scope_catalog.map(scope=><label key={scope.id} className="flex items-start gap-3 cursor-pointer"><input type="checkbox" className="mt-1 accent-indigo-500" aria-label={`${scope.name} permission for ${label}`} checked={m.scopes?.includes(scope.id)||false} onChange={e=>changeScope(m,scope,e.target.checked)}/><span><span className="text-sm font-medium">{scope.name}</span><span className="block text-xs text-zinc-400 mt-1">{scope.description}</span></span></label>)}
    <label className="flex items-start gap-3 cursor-pointer border-t border-zinc-800 pt-3"><input type="checkbox" className="mt-1 accent-indigo-500" aria-label={`SSH across owner companies for ${label}`} checked={!!m.owner_ssh} onChange={e=>changeOwnerSsh(m,e.target.checked)}/><span><span className="text-sm font-medium">SSH across all my companies</span><span className="block text-xs text-zinc-400 mt-1">Applies wherever this person has company or project access, including future grants. Company access is still required. Turning this off preserves any individual SSH scopes checked above.</span></span></label>
    {m.scopes_need_review&&<button className="text-sm text-indigo-300" onClick={()=>act(()=>api.patch(`/api/memberships/${m.grant_id}`,{scopes:m.scopes}))}>Apply these scopes to the current company</button>}
   </fieldset>}
  </section>;
 }
 return <div className={embedded?'':'fixed inset-0 z-50 bg-black/60 p-4 flex items-center justify-center'} onClick={embedded?undefined:onClose}><section role={embedded?'region':'dialog'} aria-modal={embedded?undefined:true} aria-label="Members" onClick={e=>e.stopPropagation()} className={embedded?'space-y-5':'w-full max-w-3xl max-h-[90vh] overflow-auto rounded-2xl bg-zinc-900 border border-zinc-700 p-6 space-y-5'}>
  <header className="flex justify-between gap-4"><h2 className="text-xl font-semibold">{kind==='companies'?'Company':'Project'} members</h2>{!embedded&&<button aria-label="Close members" onClick={onClose}>✕</button>}</header>
  <p className="text-sm text-zinc-400">{kind==='companies'?'Company members can access every project in this company. People added to individual projects are listed separately below.':'Project members can access this project. Company access is inherited.'} Added members do not need a paid account.</p>
  {data&&<p className="text-sm">{data.usage.users} users across this account · {data.user_limit===null?'Unlimited users':`${data.user_limit} user allowance`}</p>}
  {error&&<p role="alert" className="text-rose-300 text-sm">{error}</p>}{notice&&<p role="status" className="text-emerald-300 text-sm">{notice}</p>}
  {data&&<><form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();act(async()=>{await api.post(base,{email,role});setEmail('');setNotice('User added. Share the sign-in link below; they can sign in with an email code.');});}}><input aria-label="Member email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="teammate@company.com" className={input+' flex-1 min-w-48'}/><select aria-label="Member role" className={input} value={role} onChange={e=>setRole(e.target.value)}>{(data.allowed_roles||['editor','viewer']).map(value=><option key={value} value={value}>{value==='editor'?'Editor':'Viewer'}</option>)}</select><button disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm disabled:opacity-50">Add user</button></form>
   <p className="text-xs text-zinc-400">Editors manage tasks and files. Viewers read and download. Extra scopes are optional, separate from the task role, and only the owner can enable them. Company AI work uses the owner’s connected subscription or AI funding.</p>
   <div className="space-y-3">{data.members.map(m=>memberRow(m))}{data.inherited.map(m=>memberRow(m,true))}{!data.members.length&&!data.inherited.length&&<p className="text-sm text-zinc-500">No direct {kind==='companies'?'company':'project'} members.</p>}</div>
   {data.project_members?.length>0&&<div className="space-y-3"><h3 className="font-semibold">Project members</h3><p className="text-xs text-zinc-400">These permissions apply only to the named project.</p>{data.project_members.map(m=>memberRow(m))}</div>}
   <div className="text-sm border-t border-zinc-800 pt-4"><p className="text-zinc-400 mb-2">Share this sign-in link with the added user:</p><a href={data.sign_in_url} className="text-indigo-300 break-all">{data.sign_in_url}</a><button className="ml-3 text-indigo-300" onClick={()=>navigator.clipboard.writeText(data.sign_in_url).then(()=>setNotice('Sign-in link copied.')).catch(()=>setError('Copy the sign-in link shown here.'))}>Copy link</button></div>
  </>}
 </section></div>;
}
