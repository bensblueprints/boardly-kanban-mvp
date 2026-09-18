import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Download,X,FileText,Loader2} from 'lucide-react';
import {api} from '../api.js';
import {renderDescription} from '../markdown.mjs';

export const fileBytes=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
const button='inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
function kind(file){
 const ext=file.name.split('.').pop().toLowerCase();
 if(['xlsx','xls','ods','csv','tsv'].includes(ext))return'sheet';
 if(['png','jpg','jpeg','webp','gif','avif','bmp'].includes(ext))return'image';
 if(ext==='pdf')return'pdf';
 if(['mp4','webm','ogv'].includes(ext))return'video';
 if(['mp3','wav','ogg','m4a','flac'].includes(ext))return'audio';
 if(['md','markdown'].includes(ext))return'markdown';
 if(/^(text\/|application\/(json|xml))/.test(file.mime||'')||['txt','json','js','jsx','ts','tsx','html','css','py','sh','yaml','yml','sql','log','svg'].includes(ext))return'text';
 return'unsupported';
}
export default function FilePreview({file,onClose}){
 const dialog=useRef(null),[state,setState]=useState({loading:true}),[sheet,setSheet]=useState(0),[error,setError]=useState('');
 const type=kind(file),download=async()=>{try{await api.download(`/api/project-files/${file.id}/download`,file.name);}catch(e){setError(e.message);}};
 useEffect(()=>{
  const el=dialog.current;el.showModal();return()=>el.close();
 },[]);
 useEffect(()=>{
  let active=true,url,worker,timer;const abort=new AbortController();setState({loading:true});setSheet(0);setError('');
  async function load(){
   if(type==='unsupported'||file.size>20*1024*1024){setState({unsupported:true});return;}
   const blob=await api.blob(`/api/project-files/${file.id}/download`,abort.signal);if(!active)return;
   if(blob.size>20*1024*1024){setState({unsupported:true});return;}
   if(type==='sheet'){
    const data=await blob.arrayBuffer();if(!active)return;
    worker=new Worker(new URL('../file-preview-worker.js',import.meta.url),{type:'module'});
    timer=setTimeout(()=>{worker.terminate();if(active)setState({error:'Preview took too long. Download the original file to open it.'});},10000);
    worker.onmessage=e=>{clearTimeout(timer);worker.terminate();if(active)setState(e.data);};
    worker.onerror=()=>{clearTimeout(timer);worker.terminate();if(active)setState({error:'Preview is unavailable. Download the original file to open it.'});};
    worker.postMessage(data,[data]);
   }else if(type==='text'||type==='markdown'){
    const text=await blob.slice(0,200000).text();if(active)setState({text,truncated:blob.size>200000});
   }else{
    const mime=type==='pdf'?'application/pdf':type==='image'?`image/${file.name.split('.').pop().toLowerCase().replace('jpg','jpeg')}`:blob.type;
    url=URL.createObjectURL(new Blob([blob],{type:mime}));setState({url});
   }
  }
  load().catch(e=>{if(active&&e.name!=='AbortError')setState({error:e.message});});
  return()=>{active=false;abort.abort();worker?.terminate();clearTimeout(timer);if(url)URL.revokeObjectURL(url);};
 },[file.id]);
 const selected=state.sheets?.[sheet];
 return createPortal(<dialog ref={dialog} aria-label={`Preview ${file.name}`} onCancel={e=>{e.preventDefault();onClose();}} className="file-preview-dialog m-auto rounded-2xl border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-2xl backdrop:bg-black/60">
  <div className="flex h-full min-h-0 flex-col">
   <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 p-3 sm:p-4"><FileText className="hidden shrink-0 text-indigo-300 sm:block" size={20}/><div className="min-w-0 flex-1"><h2 className="truncate font-semibold" title={file.name}>{file.name}</h2><p className="text-xs text-zinc-400">{fileBytes(file.size)}</p></div><button aria-label="Download original file" className={button} onClick={download}><Download size={16}/><span className="hidden sm:inline">Download</span></button><button className={button} aria-label="Close file preview" onClick={onClose}><X size={18}/></button></header>
   {error&&<p role="alert" className="px-4 py-2 text-sm text-rose-300">{error}</p>}
   {state.sheets&&<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2"><label className="flex min-w-0 items-center gap-2 text-sm">Sheet<select aria-label="Spreadsheet sheet" value={sheet} onChange={e=>setSheet(Number(e.target.value))} className="min-w-0 max-w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-2">{state.sheets.map((s,i)=><option key={i} value={i}>{s.name}</option>)}</select></label>{(selected?.truncated||state.truncatedSheets)&&<p className="text-xs text-zinc-400">Preview shows up to 200 rows, 50 columns and 30 sheets. Download for the complete file.</p>}</div>}
   <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3 sm:p-4">
    {state.loading?<p role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-zinc-400"><Loader2 size={18} className="animate-spin"/>Loading preview…</p>:state.error?<p role="alert" className="p-5 text-sm text-rose-300">{state.error}</p>:state.unsupported?<div className="flex h-full flex-col items-center justify-center gap-4 text-center"><FileText size={40} className="text-zinc-500"/><p className="text-sm text-zinc-400">{file.size>20*1024*1024?'This file is too large for an in-app preview.':'Preview is unavailable for this file type.'}</p><button className={button} onClick={download}><Download size={16}/>Download {file.name}</button></div>:selected?<table aria-label={`Sheet ${selected.name}`} className="w-max min-w-full border-collapse text-left text-xs"><tbody>{selected.rows.map((row,r)=><tr key={r} className={r===0?'sticky top-0 bg-zinc-800 font-semibold':'even:bg-zinc-900'}>{row.map((cell,c)=><td key={c} className="min-w-24 max-w-96 whitespace-pre-wrap break-words border border-zinc-700 px-3 py-2 align-top">{cell}</td>)}</tr>)}</tbody></table>:type==='image'?<img src={state.url} alt={file.name} className="mx-auto max-h-full max-w-full object-contain"/>:type==='pdf'?<iframe src={state.url} title={file.name} className="h-full min-h-64 w-full rounded-lg bg-white"/>:type==='video'?<video src={state.url} controls className="mx-auto max-h-full max-w-full"/>:type==='audio'?<audio src={state.url} controls className="mx-auto w-full max-w-xl"/>:<>{type==='markdown'?<article className="md-body break-words" dangerouslySetInnerHTML={{__html:renderDescription(state.text||'')}}/>:<pre className="whitespace-pre-wrap break-words text-sm text-zinc-200">{state.text}</pre>}{state.truncated&&<p className="mt-4 text-xs text-amber-200">Preview shortened. Download for the complete file.</p>}</>}
   </div>
  </div>
 </dialog>,document.body);
}
