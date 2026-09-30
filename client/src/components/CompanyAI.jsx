import ModelTest from './ModelTest.jsx';
import React,{useEffect,useState} from 'react';
import {BrainCircuit,ArrowDown,Building2} from 'lucide-react';
import {api} from '../api.js';
import {settingsButton,settingsInput} from './SettingsShell.jsx';
import AIProviderConnection from './AIProviderConnection.jsx';

export default function CompanyAI({companyId}){
 const [data,setData]=useState(null),[source,setSource]=useState('inherit'),[provider,setProvider]=useState('deepseek'),[model,setModel]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const base=`/api/companies/${companyId}/ai`;
 async function load(reset=false){const d=await api.get(base);setData(d);if(reset){setSource(d.policy.source);setProvider(d.policy.provider||'deepseek');setModel(d.policy.model||'');}return d;}
 useEffect(()=>{load(true).catch(e=>setError(e.message));},[companyId]);
 const label=p=>({chatgpt:'ChatGPT / Codex',subscription:'Codex worker',openai:'OpenAI',none:'Not connected'}[p]||data?.organization_connections.find(c=>c.provider===p)?.label||p);
 const connections=source==='company'?data?.company_connections:data?.organization_connections;
 const selected=connections?.find(c=>c.provider===provider);
 function changeProvider(value){setProvider(value);setModel(connections?.find(c=>c.provider===value)?.model||'');setNotice('');}
 async function save(e){e.preventDefault();setBusy(true);setError('');setNotice('');try{await api.put(base,{source,provider,model});await load(true);setNotice('Company AI saved. New requests and delegated work use this selection.');}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <div className="space-y-6">
  <p className="text-sm text-zinc-400">This company’s Departments and Boards use its AI selection. When the Organization agent delegates work here, the company AI carries it out with the Board’s existing permissions.</p>
  {error&&<p role="alert" className="text-rose-300">{error}</p>}{notice&&<p role="status" className="text-emerald-300">{notice}</p>}
  {data&&<>
   <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-3" aria-label="Effective company AI"><p className="text-sm flex gap-2"><Building2 size={18}/>Organization <span className="ml-auto text-zinc-400 break-all">{data.organization.provider} · {data.organization.model}</span></p><ArrowDown size={16} className="text-zinc-500"/><p className="text-sm flex gap-2"><BrainCircuit size={18}/>Company <span className="ml-auto text-indigo-200 break-all">{data.effective.provider} · {data.effective.model}</span></p><p className="text-xs text-zinc-400">{data.effective.source==='inherit'?'Inherits Organization AI. Organization changes apply automatically.':data.effective.source==='organization'?'Uses a saved Organization connection with this company’s chosen model.':'Uses a connection saved only for this company.'}</p></div>
   <form onSubmit={save} className="space-y-4">
    <fieldset className="grid lg:grid-cols-3 gap-3"><legend className="text-sm font-medium mb-3">AI connection source</legend>{[['inherit','Inherit Organization AI'],['organization','Choose an Organization connection'],['company','Use a company connection']].map(([value,label])=><label key={value} className={'flex gap-3 rounded-xl border p-4 text-sm cursor-pointer '+(source===value?'border-indigo-400 bg-indigo-500/10':'border-zinc-700')}><input type="radio" name="company-ai-source" value={value} checked={source===value} onChange={()=>{setSource(value);setModel('');setNotice('');}}/>{label}</label>)}</fieldset>
    {source!=='inherit'&&<><label className="block text-sm">Provider<select aria-label="Company AI provider" className={settingsInput+' mt-2'} value={provider} onChange={e=>changeProvider(e.target.value)}>{connections?.map(c=><option key={c.provider} value={c.provider}>{c.label}{c.saved?' · connected':''}</option>)}</select></label>
     {selected?.saved?<label className="block text-sm">Model<select required aria-label="Company AI model" className={settingsInput+' mt-2'} value={model} onChange={e=>setModel(e.target.value)}><option value="">Choose a model</option>{selected.models.map(m=><option key={m} value={m}>{m}</option>)}</select></label>:<p className="text-sm text-amber-200">{source==='company'?'Verify the company connection below to load its models.':'Connect this provider in Organization settings first.'}</p>}
    </>}
    <button disabled={busy||(source!=='inherit'&&(!selected?.saved||!model))} className={settingsButton+' bg-indigo-600'}>{busy?'Saving…':'Save company AI'}</button>
   </form>
   <ModelTest url={base+'/test'} selection={{source,provider,model}} disabled={busy||(source!=='inherit'&&(!selected?.saved||!model))}/>
   {source==='company'&&<section className="border-t border-zinc-800 pt-5 space-y-4"><h3 className="font-semibold">Company connection</h3><AIProviderConnection key={companyId+provider} provider={provider} companyId={companyId} onSaved={async()=>{const d=await load();setModel(d.company_connections.find(c=>c.provider===provider)?.model||'');}}/></section>}
   <a href="#/settings/connectors" className="inline-block text-sm text-indigo-300">Manage Organization connections</a>
  </>}
 </div>;
}
