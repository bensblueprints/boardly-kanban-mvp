import ModelTest from './ModelTest.jsx';
import React,{useEffect,useState} from 'react';
import {BrainCircuit,ArrowDown,Building2} from 'lucide-react';
import {api} from '../api.js';
import {settingsButton,settingsInput} from './SettingsShell.jsx';
import AIProviderConnection from './AIProviderConnection.jsx';

export default function CompanyAI({companyId,scopeKind='company',scopeId=companyId}){
 const [data,setData]=useState(null),[source,setSource]=useState('inherit'),[provider,setProvider]=useState('deepseek'),[model,setModel]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const scopeLabel={company:'Company',department:'Department',project:'Board'}[scopeKind],base=`/api/${{company:'companies',department:'departments',project:'projects'}[scopeKind]}/${scopeId}/ai`;
 async function load(reset=false){const d=await api.get(base);setData(d);if(reset){setSource(d.policy.source);setProvider(d.policy.provider||'deepseek');setModel(d.policy.model||'');}return d;}
 useEffect(()=>{setData(null);setError('');setNotice('');load(true).catch(e=>setError(e.message));},[base]);
 const connections=source==='company'?data?.company_connections:data?.organization_connections,selected=connections?.find(c=>c.provider===provider),parent=data?.parent?.scope?.label||'Organization';
 function changeProvider(value){setProvider(value);setModel(connections?.find(c=>c.provider===value)?.model||'');setNotice('');}
 async function save(e){e.preventDefault();setBusy(true);setError('');setNotice('');try{await api.put(base,{source,provider,model});await load(true);setNotice(`${scopeLabel} AI saved. New requests and delegated work use this selection.`);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <div className="space-y-6">
  <p className="text-sm text-zinc-400">{scopeKind==='company'?'Departments and Boards inherit this selection unless they choose their own model.':scopeKind==='department'?'Boards in this Department inherit this selection unless they choose their own model.':"This selection applies to this Board's AI chat and delegated work."} Model choices keep the existing work permissions.</p>
  {error&&<p role="alert" className="text-rose-300">{error}</p>}{notice&&<p role="status" className="text-emerald-300">{notice}</p>}
  {data&&<>
   <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-3" aria-label={`Effective ${scopeLabel.toLowerCase()} AI`}><p className="text-sm flex gap-2"><Building2 size={18}/>{parent} <span className="ml-auto text-zinc-400 break-all">{data.parent?.provider||data.organization.provider} / {data.parent?.model||data.organization.model}</span></p><ArrowDown size={16} className="text-zinc-500"/><p className="text-sm flex gap-2"><BrainCircuit size={18}/>{scopeLabel} <span className="ml-auto text-indigo-200 break-all">{data.effective.provider} / {data.effective.model}</span></p><p className="text-xs text-zinc-400">{data.effective.source==='inherit'?`Inherits ${parent} AI. Parent changes apply automatically.`:data.effective.source==='organization'?`Uses a saved Organization connection with this ${scopeLabel.toLowerCase()}'s chosen model.`:'Uses a connection saved for this Company.'}</p>{data.effective.error&&<p role="alert" className="text-amber-200 text-sm">{data.effective.error}</p>}</div>
   <form onSubmit={save} className="space-y-4">
    <fieldset className="grid lg:grid-cols-3 gap-3"><legend className="text-sm font-medium mb-3">AI connection source</legend>{[['inherit',`Inherit ${parent} AI`],['organization','Choose an Organization connection'],...(data.company_id!=null?[['company','Use a company connection']]:[])].map(([value,label])=><label key={value} className={'flex gap-3 rounded-xl border p-4 text-sm cursor-pointer '+(source===value?'border-indigo-400 bg-indigo-500/10':'border-zinc-700')}><input type="radio" name={`${scopeKind}-ai-source`} value={value} checked={source===value} onChange={()=>{setSource(value);setModel('');setNotice('');}}/>{label}</label>)}</fieldset>
    {source!=='inherit'&&<><label className="block text-sm">Provider<select aria-label={`${scopeLabel} AI provider`} className={settingsInput+' mt-2'} value={provider} onChange={e=>changeProvider(e.target.value)}>{connections?.map(c=><option key={c.provider} value={c.provider}>{c.label}{c.saved?' / connected':''}</option>)}</select></label>
     {selected?.saved?<label className="block text-sm">Model<select required aria-label={`${scopeLabel} AI model`} className={settingsInput+' mt-2'} value={model} onChange={e=>setModel(e.target.value)}><option value="">Choose a model</option>{selected.models.map(m=><option key={m} value={m}>{m}</option>)}</select></label>:<p className="text-sm text-amber-200">{source==='company'?(scopeKind==='company'?'Verify the company connection below to load its models.':'Connect this provider in Company settings first.'):'Connect this provider in Organization settings first.'}</p>}
    </>}
    <button disabled={busy||(source!=='inherit'&&(!selected?.saved||!model))} className={settingsButton+' bg-indigo-600'}>{busy?'Saving...':`Save ${scopeLabel.toLowerCase()} AI`}</button>
   </form>
   <ModelTest url={base+'/test'} selection={{source,provider,model}} disabled={busy||(source!=='inherit'&&(!selected?.saved||!model))}/>
   {source==='company'&&scopeKind==='company'&&<section className="border-t border-zinc-800 pt-5 space-y-4"><h3 className="font-semibold">Company connection</h3><AIProviderConnection key={scopeId+provider} provider={provider} companyId={scopeId} onSaved={async()=>{const d=await load();setModel(d.company_connections.find(c=>c.provider===provider)?.model||'');}}/></section>}
   {scopeKind!=='company'&&data.company_id!=null&&<a href={`#/company/${data.company_id}/settings/ai`} className="inline-block mr-5 text-sm text-indigo-300">Manage Company AI connections</a>}
   <a href="#/settings/connectors" className="inline-block text-sm text-indigo-300">Manage Organization connections</a>
  </>}
 </div>;
}
