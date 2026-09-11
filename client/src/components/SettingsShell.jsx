import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, Search, Settings2} from 'lucide-react';

export const settingsButton='inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50';
export const settingsInput='w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm';
export const accountSettings=section=>window.dispatchEvent(new CustomEvent('boardly-account',{detail:{section}}));

// These are real routes, so refresh and browser Back preserve the selected scope.
export default function SettingsShell({scope, name, sections, section, onSelect, onBack, children}) {
 const [query,setQuery]=useState('');
 const heading=useRef(null),mounted=useRef(false);
 const current=sections.find(s=>s.id===section);
 useEffect(()=>{if(mounted.current)heading.current?.focus({preventScroll:true});mounted.current=true;},[section]);
 const results=sections.filter(s=>(s.label+' '+s.description+' '+(s.keywords||'')).toLowerCase().includes(query.toLowerCase().trim()));
 return <main className="settings-shell max-w-7xl mx-auto p-4 sm:p-7 lg:p-9">
  <button onClick={onBack} className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 mb-6"><ArrowLeft size={16}/>Back to {scope==='Account'?'workspace':scope.toLowerCase()}</button>
  <header className="flex items-center gap-3 mb-6"><span className="rounded-xl border border-zinc-700 bg-zinc-900 p-3"><Settings2 size={24} className="text-indigo-300"/></span><div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wider text-indigo-300">{scope} settings</p><h1 className="text-xl sm:text-2xl font-semibold truncate mt-1">{name}</h1></div></header>
  <div className="grid md:grid-cols-[220px_minmax(0,1fr)] gap-5 lg:gap-9 items-start">
   <aside className="md:sticky md:top-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
    <label className="relative block mb-3"><Search size={15} className="absolute left-3 top-3 text-zinc-500"/><input aria-label={`Search ${scope.toLowerCase()} settings`} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a setting…" className={settingsInput+' pl-9'}/></label>
    <label className="block md:hidden text-xs text-zinc-400 mb-2">Settings section<select aria-label={`${scope} settings section`} value={current?section:''} onChange={e=>{onSelect(e.target.value);setQuery('');}} className={settingsInput+' mt-2 text-zinc-100'}>{!current&&<option value="">Choose a setting</option>}{sections.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
    <nav aria-label={`${scope} settings`} className={(query?'grid':'hidden md:grid')+' grid-cols-2 gap-1 md:grid-cols-1'}>{results.map(s=><button key={s.id} aria-current={section===s.id?'page':undefined} onClick={()=>{onSelect(s.id);setQuery('');}} className={'flex items-center gap-2.5 text-left px-3 py-2.5 rounded-lg text-sm '+(section===s.id?'bg-indigo-500/15 text-indigo-200 font-medium':'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100')}>{s.icon&&<s.icon size={17} className="shrink-0"/>}{s.label}</button>)}</nav>
    {!results.length&&<p role="status" className="p-2 text-sm text-zinc-400">No settings match. <button className="text-indigo-300 underline" onClick={()=>setQuery('')}>Clear search</button></p>}
    <p className="hidden md:block text-xs text-zinc-500 border-t border-zinc-800 pt-3 mt-3">{scope==='Account'?'Account connections can be reused across your companies.':`Changes here apply to this ${scope.toLowerCase()}. Member permissions still apply.`}</p>
   </aside>
   <section aria-label={current?.label||'Settings content'} className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-6 space-y-6">
    <header className="border-b border-zinc-800 pb-5"><h2 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">{current?.label||'Setting unavailable'}</h2><p className="text-sm text-zinc-400 mt-2 leading-relaxed">{current?.description||'This setting is not available with your current access.'}</p></header>
    {current?children:<button className={settingsButton} onClick={()=>onSelect(sections[0].id)}>Open available settings</button>}
   </section>
  </div>
 </main>;
}
