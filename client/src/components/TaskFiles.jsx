import React,{useEffect,useState} from 'react';
import {FileText,Download,ExternalLink,Link,Unlink,ChevronDown} from 'lucide-react';
import {api} from '../api.js';
import FilePreview,{fileBytes} from './FilePreview.jsx';

export default function TaskFiles({cardId,board,onBoardChange}){
 const readOnly=board.permissions?.role==='viewer';
 const [files,setFiles]=useState([]),[ready,setReady]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(null);
 const [expanded,setExpanded]=useState(false),[linking,setLinking]=useState(false),[choices,setChoices]=useState(null),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false);
 const base=`/api/cards/${cardId}/files`;
 async function reload(){const data=await api.get(base);setFiles(data.files);setReady(true);}
 useEffect(()=>{
  let alive=true,loading=false;
  const poll=async()=>{if(loading||document.visibilityState==='hidden')return;loading=true;try{const data=await api.get(base);if(alive){setFiles(data.files);setReady(true);}}catch(e){if(alive)setError(e.message);}finally{loading=false;}};
  poll();const timer=setInterval(poll,5000);return()=>{alive=false;clearInterval(timer);};
 },[cardId]);
 async function choose(){
  setLinking(true);setChoices(null);setError('');
  try{const data=await api.get(`/api/boards/${board.id}/files`);setChoices(data.files);}catch(e){setError(e.message);}
 }
 async function mutate(action){
  if(busy)return;setBusy(true);setError('');
  try{await action();await reload();onBoardChange?.();}catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function download(file){try{await api.download(`/api/project-files/${file.id}/download`,file.name);}catch(e){setError(e.message);}}
 const available=choices?.filter(f=>!files.some(x=>x.id===f.id)),visible=expanded?files:files.slice(0,5);
 return <section aria-label="Task outputs" className="mx-5 mb-5 rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-3 sm:p-4">
  <div className="flex flex-wrap items-center gap-2"><FileText size={17} className="text-indigo-300"/><h3 className="text-sm font-semibold">Outputs{files.length>0&&<span className="ml-2 text-xs font-normal text-zinc-400">{files.length}</span>}</h3>{!readOnly&&<button type="button" onClick={choose} disabled={busy} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-indigo-300 hover:bg-indigo-500/10"><Link size={14}/>Link existing file</button>}</div>
  {error&&<p role="alert" className="mt-2 text-sm text-rose-300">{error}</p>}
  {!ready?<p className="py-3 text-sm text-zinc-400">Loading task files…</p>:files.length===0?<p className="py-3 text-sm text-zinc-400">Files generated from this task’s chat will appear here.</p>:<div className="mt-3 space-y-2">{visible.map(file=><div key={file.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-950/60 p-2">
   <FileText size={17} className="shrink-0 text-indigo-300"/>
   {file.url?<a href={file.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 break-words text-sm text-indigo-200 hover:underline">{file.name}<ExternalLink size={12} className="ml-1 inline"/></a>:<button type="button" aria-label={`View ${file.name}`} onClick={()=>setPreview(file)} className="min-w-0 flex-1 text-left"><span className="block break-words text-sm text-indigo-200 hover:underline">{file.name}</span><span className="text-[11px] text-zinc-500">{fileBytes(file.size)} · {new Date(file.created_at).toLocaleString()}</span></button>}
   {!file.url&&<button type="button" aria-label={`Download ${file.name}`} title="Download file" onClick={()=>download(file)} className="shrink-0 rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-indigo-200"><Download size={16}/></button>}
   {!readOnly&&<button type="button" aria-label={`Remove shortcut to ${file.name}`} title="Remove shortcut · file stays in Files" disabled={busy} onClick={()=>mutate(()=>api.del(base+'/'+file.id))} className="shrink-0 rounded-lg p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><Unlink size={15}/></button>}
  </div>)}</div>}
  {files.length>5&&<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-3 flex items-center gap-1 text-xs text-indigo-300"><ChevronDown size={14} className={expanded?'rotate-180':''}/>{expanded?'Show fewer files':`Show all ${files.length} files`}</button>}
  {linking&&<form aria-label="Link file to task" className="mt-3 space-y-2 border-t border-zinc-700 pt-3" onSubmit={e=>{e.preventDefault();mutate(async()=>{await api.post(base,{file_id:Number(selected)});setLinking(false);setSelected('');});}}><label className="block text-xs text-zinc-400">Project file<select aria-label="Project file to link" disabled={busy||choices===null} value={selected} onChange={e=>setSelected(e.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"><option value="">{choices===null?'Loading…':available.length?'Choose a file':'All project files are already linked'}</option>{available?.map(f=><option key={f.id} value={f.id}>{f.name}{f.folder_path?' · '+f.folder_path:''}</option>)}</select></label><div className="flex gap-2"><button disabled={busy||!selected} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm disabled:opacity-40">Link file</button><button type="button" disabled={busy} onClick={()=>{setLinking(false);setSelected('');}} className="rounded-lg px-3 py-2 text-sm text-zinc-400">Cancel</button></div></form>}
  {preview&&<FilePreview key={preview.id} file={preview} onClose={()=>setPreview(null)}/>}
 </section>;
}
