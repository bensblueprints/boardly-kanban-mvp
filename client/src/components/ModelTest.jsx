import React,{useEffect,useRef,useState} from 'react';
import {Radio,CheckCircle2,AlertCircle,Loader2} from 'lucide-react';
import {api} from '../api.js';
import {settingsButton} from './SettingsShell.jsx';

export default function ModelTest({url,selection,disabled=false}){
 const [busy,setBusy]=useState(false),[result,setResult]=useState(null);
 const signature=url+JSON.stringify(selection),current=useRef(signature),mounted=useRef(true);current.current=signature;
 useEffect(()=>{setResult(null);},[signature]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function test(){
  const selected=signature;setBusy(true);setResult(null);
  try{const response=await api.post(url,selection);if(mounted.current&&current.current===selected)setResult(response);}
  catch(e){if(mounted.current&&current.current===selected)setResult({ok:false,error:e.message});}
  finally{if(mounted.current)setBusy(false);}
 }
 return <div className="space-y-3" aria-label="Model connection test">
  <button type="button" disabled={disabled||busy} onClick={test} className={settingsButton}>{busy?<Loader2 size={16} className="animate-spin"/>:<Radio size={16}/>} {busy?'Testing model…':'Test model'}</button>
  <p className="text-xs text-zinc-400">Sends a short ping to the selected model without changing your default. Uses a small amount of provider usage.</p>
  {busy&&<p role="status" className="text-sm text-zinc-400">Waiting for the model’s reply…</p>}
  {result&&<div role={result.ok?'status':'alert'} className={'rounded-xl border p-4 space-y-2 text-sm '+(result.ok?'border-emerald-500/30 bg-emerald-500/5':'border-rose-500/30 bg-rose-500/5')}>
   <p className={'flex items-center gap-2 font-medium '+(result.ok?'text-emerald-300':'text-rose-300')}>{result.ok?<CheckCircle2 size={17}/>:<AlertCircle size={17}/>} {result.ok?'Model is online and responding':'Model test failed'}{result.latency_ms!=null&&<span className="ml-auto font-normal text-xs">{(result.latency_ms/1000).toFixed(2)} s</span>}</p>
   {result.model&&<p className="text-xs text-zinc-400 break-all">{result.model} · {new Date(result.tested_at).toLocaleTimeString()}</p>}
   <p className="whitespace-pre-wrap break-words">{result.ok?result.reply:result.error}</p>
  </div>}
 </div>;
}
