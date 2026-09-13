import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
import SshSetup from './SshSetup.jsx';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
const field='block mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3';
const base='/api/account/computeruse/vision';

export default function ComputerVisionSettings(){
 const [data,setData]=useState(null),[mode,setMode]=useState('gpt'),[connection,setConnection]=useState(''),[share,setShare]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[setup,setSetup]=useState(false),[network,setNetwork]=useState(null),[installing,setInstalling]=useState(null);
 const alive=useRef(true);
 async function load(reset=false){const next=await api.get(base);if(!alive.current)return;setData(next);if(reset){setMode(next.mode);setConnection(next.connection_id||'');setShare(!!next.share_with_company);}}
 useEffect(()=>{alive.current=true;load(true).catch(e=>setError(e.message));return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!installing)return;let cancelled=false,timer;const poll=async()=>{try{const r=await api.post(base+'/install-status',{connection_id:installing});if(cancelled)return;setNotice(r.message);if(r.status==='error'){setError(r.message);setInstalling(null);}else if(r.status==='installed'){await api.post(base+'/detect',{connection_id:installing});if(cancelled)return;setInstalling(null);await load();}else timer=setTimeout(poll,5000);}catch(e){if(!cancelled){setError(e.message);setInstalling(null);}}};timer=setTimeout(poll,3000);return()=>{cancelled=true;clearTimeout(timer);};},[installing]);
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{if(alive.current)setBusy(false);}}
 const selected=data?.connections.find(c=>c.id===connection),ready=selected?.allow_agent&&selected?.has_fingerprint;
 const found=selected?.detection,canInstall=found?.can_install&&Date.now()-found.detected_at<30*60*1000;
 return <section aria-label="Computer vision mode" className="rounded-xl border border-zinc-700 p-4 space-y-4">
  <h4 className="font-medium">How AI reads your computer</h4>
  <p className="text-sm text-zinc-400">Choose for your account. GPT plans the task in both modes. You can switch whenever you need.</p>
  {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-300">{notice}</p>}
  {!data?<p className="text-sm text-zinc-400">Loading vision settings…</p>:<>
   <label className="block text-sm">Vision mode<select aria-label="Vision mode" className={field} value={mode} onChange={e=>setMode(e.target.value)} disabled={busy}><option value="gpt">GPT only</option><option value="local">GPT + my GPU</option></select></label>
   <p className="text-sm text-zinc-400">{mode==='gpt'?'GPT receives screenshots and reads the screen. This uses your connected GPT plan or API allowance.':'Qwen reads screenshots on your GPU. GPT receives short text findings and still uses your GPT allowance for planning. If your GPU is unavailable, screen reading pauses until it is back or you choose GPT only.'}</p>
   {mode==='local'&&<>
    <label className="block text-sm">My GPU computer<select aria-label="My GPU computer" className={field} value={connection} disabled={busy||!!installing} onChange={e=>{setConnection(e.target.value);setNotice('');setError('');}}><option value="">Choose a connected computer</option>{data.connections.map(c=><option key={c.id} value={c.id}>{c.label}{!c.allow_agent?' · agent access off':c.tested?' · tested':''}</option>)}</select></label>
    <p className="text-xs text-zinc-400">Setup supports Linux x86_64 with Vulkan graphics drivers and at least 12 GB of GPU memory; 16 GB is recommended. Connect your own computer to use this mode in a new account.</p>
    <div className="flex flex-wrap gap-2">
     <button className={button} disabled={busy||!!installing} onClick={()=>act(async()=>{setNetwork(await api.get('/api/account/tailscale'));setSetup(true);})}>Connect a GPU computer</button>
     <button className={button} disabled={busy||!ready||!!installing} onClick={()=>act(async()=>{await api.post(base+'/detect',{connection_id:connection});await load();setNotice('GPU and model detection finished. Review the results below.');})}>Detect GPU &amp; models</button>
     <button className={button} disabled={busy||!ready||!canInstall||!!installing} onClick={()=>act(async()=>{const r=await api.post(base+'/install',{connection_id:connection});setNotice(r.message);setInstalling(connection);})}>{found&&!found.needs_install?'Verify / repair setup':found?.download_bytes===0?'Repair vision service':'Install missing vision models'}</button>
     <button className={button} disabled={busy||!ready||!!installing} onClick={()=>act(async()=>{const r=await api.post(base+'/test',{connection_id:connection});await load();setNotice(`GPU passed the screen-reading test in ${(r.elapsed_ms/1000).toFixed(1)} seconds. You can now save this mode.`);})}>Test GPU</button>
    </div>
    {ready&&!found&&<p className="text-sm text-zinc-400">Detect your GPU first. Boardly will check its memory and which model files need installing.</p>}
    {found&&<div className="rounded-lg bg-zinc-900 p-3 text-sm space-y-2" aria-label="GPU detection results">
     {found.gpus.length?found.gpus.map((gpu,i)=><p key={i}>{gpu.name} · {(gpu.memory_mib/1024).toFixed(1)} GB GPU memory · {(gpu.free_mib/1024).toFixed(1)} GB currently free</p>):<p>No graphics card detected.</p>}
     <p className="text-zinc-400">{found.os} {found.architecture} · Models {found.model_files_present?'found':'missing'} · Runtime {found.runtime_present?'found':'missing'} · Vision service {found.service_available?'online':'offline'}</p>
     <p className="text-zinc-400">{found.download_bytes>0?`About ${(found.download_bytes/1073741824).toFixed(1)} GB to download.`:'No model download needed.'} {(found.disk_free_bytes/1073741824).toFixed(1)} GB disk space available. A screen-reading test confirms the setup works.</p>
     {found.reasons.map((reason,i)=><p key={i} className="text-amber-200">{reason}</p>)}
     {!canInstall&&found.can_install&&<p className="text-amber-200">Detect the GPU again before installing; these results are over 30 minutes old.</p>}
    </div>}
    {selected&&!ready&&<p className="text-sm text-amber-200">Enable Work agent access and trust this computer in <button className="underline" onClick={()=>window.dispatchEvent(new CustomEvent('boardly-account',{detail:{section:'ssh'}}))}>account SSH settings</button>.</p>}
    <p className="text-xs text-zinc-400">Keep the GPU computer online. Qwen yields to ComfyUI image jobs and releases idle memory. Installing downloads verified model files and adds a private background service to the selected computer. Existing image models stay in place.</p>
    <label className="flex gap-3 items-start text-sm"><input type="checkbox" className="mt-1" checked={share} disabled={busy} onChange={e=>setShare(e.target.checked)}/><span>Let company members use my GPU for vision<span className="block mt-1 text-xs text-zinc-400">Applies to company members with edit access and Computer use permission in their project. Sharing vision does not grant SSH or access to your GPU desktop. Users outside your companies must connect their own GPU.</span></span></label>
    {setup&&<SshSetup base="/api/account/ssh" kind="owner" network={network} onCancel={()=>setSetup(false)} onDone={message=>{setSetup(false);setNotice(message);load();}}/>}
   </>}
   <div className="flex flex-wrap items-center gap-3"><button className={button+' bg-indigo-600'} disabled={busy||(mode==='local'&&(!ready||!selected?.tested))} onClick={()=>act(async()=>{await api.put(base,{mode,connection_id:connection||null,share_with_company:share});await load(true);setNotice(mode==='local'?'GPT + my GPU is active. Screenshot tools now return local Qwen findings.':'GPT only is active. Screenshot tools now use GPT vision.');window.dispatchEvent(new Event('boardly-computeruse-changed'));})}>{busy?'Working…':'Save vision mode'}</button><span className="text-xs text-zinc-400">Active: {data.mode==='local'?'GPT + my GPU':'GPT only'}</span></div>
  </>}
 </section>;
}
