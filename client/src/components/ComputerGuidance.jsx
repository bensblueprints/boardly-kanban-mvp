import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';

export default function ComputerGuidance({job,human,open}) {
  const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[data,setData]=useState(null);
  const request=useRef(null),sending=useRef(false);
  const base=`/api/chat/jobs/${job.id}/guidance`;
  useEffect(()=>{
    if(!open)return;
    let alive=true,loading=false;
    const load=async()=>{if(loading)return;loading=true;try{const value=await api.get(base);if(alive){setData(value);}}catch(e){if(alive)setError(e.message);}finally{loading=false;}};
    load();const timer=setInterval(load,2000);return()=>{alive=false;clearInterval(timer);};
  },[base,open]);
  const status=data?.job?.status||job.status,paused=['blocked','failed','interrupted'].includes(status);
  const ended=!['queued','running','recovering','blocked','failed','interrupted'].includes(status);
  const instructions=data?.instructions||[],latest=instructions.at(-1);
  async function send(e){
    e.preventDefault();if(sending.current||!draft.trim()||ended||(paused&&human))return;
    sending.current=true;setBusy(true);setError('');
    // Keep the same operation ID after an uncertain response, including resume retries.
    if(!request.current||request.current.content!==draft.trim())request.current={operation_id:crypto.randomUUID(),content:draft.trim(),resume:paused};
    const submitted=request.current;
    try{
      const result=await api.post(base,submitted);
      setData(old=>({...old,job:{...old?.job,status:result.status},instructions:result.instructions}));
      setDraft(value=>value.trim()===submitted.content?'':value);request.current=null;
    }catch(e){setError(e.message);}
    finally{sending.current=false;setBusy(false);}
  }
  return <section className="computer-guidance max-h-[35dvh] shrink-0 overflow-y-auto border-t border-zinc-800 p-2" aria-label="Agent instructions">
    <form onSubmit={send}>
      <label htmlFor="computer-agent-instruction" className="block text-xs font-medium text-zinc-200">Guide this task</label>
      <div className="mt-1 flex gap-2">
        <textarea id="computer-agent-instruction" rows={1} maxLength={10000} value={draft} onChange={e=>setDraft(e.target.value)}
          onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form.requestSubmit();}}}
          placeholder="Tell the agent what to do next…" disabled={ended}
          className="min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-base text-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-400"/>
        <button disabled={busy||!draft.trim()||ended||(paused&&human)} className="min-h-11 shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400">{busy?'Sending…':paused?'Resume with instruction':'Send'}</button>
      </div>
    </form>
    <p className="mt-1 truncate text-xs text-zinc-400" title={data?.job?.blocker||data?.job?.progress}>
      {human?'Desktop control stays with you until Give Back to Agent.':ended?'This run has ended. Continue in the project chat.':paused?data?.job?.blocker||'Task paused. Add guidance to resume.':data?.job?.progress||'Guidance resumes the same task with your new instruction.'}
    </p>
    {latest&&<p role="status" aria-atomic="true" className="mt-1 truncate text-xs text-indigo-200" title={latest.content}>{latest.received_at?'Received by agent':'Queued for agent'} · {latest.content}</p>}
    {instructions.length>1&&<details className="text-xs text-zinc-400"><summary className="cursor-pointer py-1">Recent instructions ({instructions.length})</summary><ol className="max-h-24 overflow-y-auto break-words">{instructions.map(x=><li key={x.id} className="py-1">{x.received_at?'Received':'Queued'} · {x.content}</li>)}</ol></details>}
    {error&&<p role="alert" className="mt-1 text-xs text-rose-300">{error} Your text is kept; retry Send.</p>}
  </section>;
}
