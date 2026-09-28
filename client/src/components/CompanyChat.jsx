import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const merge = (old, incoming) => [...new Map([...old,...incoming].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id);
export default function CompanyChat({ companyId, cardId }) {
  const endpoint = cardId ? `/api/cards/${cardId}/team-chat` : `/api/companies/${companyId}/team-chat`;
  const [data,setData]=useState(null),[messages,setMessages]=useState([]),[draft,setDraft]=useState('');
  const [error,setError]=useState(''),[sending,setSending]=useState(false),[older,setOlder]=useState(false),[more,setMore]=useState(false);
  const alive=useRef(false),latest=useRef(0),list=useRef(null),stick=useRef(true),retry=useRef(null);
  useEffect(()=>{
    alive.current=true;let pending=false;
    async function refresh(){
      if(pending||!alive.current)return;pending=true;
      try{
        const result=await api.get(endpoint+(latest.current?`?after=${latest.current}`:''));
        if(!alive.current)return;
        if(!latest.current)setMore(result.has_more);
        setData(result);setMessages(old=>merge(old,result.messages));setError('');
        latest.current=Math.max(latest.current,...result.messages.map(m=>m.id));
      }catch(e){if(alive.current){setError(e.message);if([401,403,404].includes(e.status)){setData(null);setMessages([]);latest.current=0;}}}
      finally{pending=false;}
    }
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    refresh();const timer=setInterval(visible,2000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
    return()=>{alive.current=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
  },[endpoint]);
  useEffect(()=>{if(stick.current&&list.current)list.current.scrollTop=list.current.scrollHeight;},[messages]);
  async function history(){
    setOlder(true);const node=list.current,height=node?.scrollHeight||0;
    try{const result=await api.get(endpoint+`?before=${messages[0].id}`);if(!alive.current)return;stick.current=false;setMessages(old=>merge(old,result.messages));setMore(result.has_more);requestAnimationFrame(()=>{if(node)node.scrollTop+=node.scrollHeight-height;});}
    catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setOlder(false);}
  }
  async function send(e){
    e.preventDefault();if(!draft.trim()||sending)return;
    const body=draft.trim();if(retry.current?.body!==body)retry.current={body,client_id:crypto.randomUUID()};
    setSending(true);setError('');
    try{const message=await api.post(endpoint,retry.current);if(!alive.current)return;stick.current=true;setMessages(old=>merge(old,[message]));setDraft('');retry.current=null;}
    catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setSending(false);}
  }
  return <section aria-label="Company team chat" className="rounded-xl border border-zinc-700 bg-zinc-950 overflow-hidden">
    <div className="px-4 py-3 border-b border-zinc-800"><h3 className="font-semibold text-sm">{data?.company.name||'Company'} · Team chat</h3><p className="text-xs text-zinc-400 mt-1">Shared with all company members. Messages are saved across tasks.</p>{data?.task&&<p className="text-xs text-indigo-300 mt-1 break-words">Posting from task: {data.task.title}</p>}</div>
    {error&&<p role="alert" className="px-4 py-3 text-sm text-amber-300">{error}</p>}
    {!data&&!error&&<p className="p-4 text-sm text-zinc-400">Loading team chat…</p>}
    {data&&<><div ref={list} onScroll={()=>{const n=list.current;stick.current=n.scrollHeight-n.scrollTop-n.clientHeight<60;}} className="h-72 sm:h-80 overflow-y-auto p-4 space-y-4">
      {more&&<button disabled={older} onClick={history} className="text-xs text-indigo-300 disabled:opacity-50">{older?'Loading…':'Load earlier messages'}</button>}
      {!messages.length&&<p className="text-sm text-zinc-500">Start the company conversation. Your team can pick it up from any task.</p>}
      {messages.map(m=><article key={m.id} className={`rounded-lg p-3 ${m.mine?'bg-indigo-500/10 border border-indigo-500/20':'bg-zinc-900'}`}><p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><strong className="text-zinc-200">{m.sender_name}{m.mine?' (you)':''}</strong><time className="text-zinc-500" dateTime={new Date(m.created_at).toISOString()}>{new Date(m.created_at).toLocaleString()}</time></p>{m.task&&<p className="text-xs text-indigo-300 mt-1 break-words">Task: {m.task.title}</p>}<p className="text-sm text-zinc-200 whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-2">{m.body}</p></article>)}
    </div><form onSubmit={send} className="border-t border-zinc-800 p-3"><textarea aria-label="Message company team" placeholder="Message your company team…" value={draft} disabled={sending} maxLength={8000} rows={2} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send(e);}}} className="w-full bg-zinc-900 border border-zinc-700 focus:border-indigo-400 rounded-lg p-3 text-sm outline-none resize-y"/><div className="flex justify-between items-center gap-2 mt-2"><span className="text-xs text-zinc-500">Enter to send · Shift+Enter for a new line</span><button disabled={sending||!draft.trim()} className="text-sm rounded-lg px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50">{sending?'Sending…':'Send'}</button></div></form></>}
  </section>;
}
