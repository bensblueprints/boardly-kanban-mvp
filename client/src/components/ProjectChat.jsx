import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Send, Square, MessageSquare } from 'lucide-react';
import { api } from '../api.js';
import RunActivity from './RunActivity.jsx';

export default function ProjectChat({ board, task = null, onClose, onUpdated, initialThreadId = null }) {
  const readOnly=board.permissions?.role==='viewer';
  const [personal,setPersonal]=useState(false),[cloud,setCloud]=useState(false),[mode,setMode]=useState('');
  const [threads, setThreads] = useState([]), [selected, setSelected] = useState('');
  const [conversation, setConversation] = useState(null), [online, setOnline] = useState(false);
  const [input, setInput] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const bottom = useRef(null), previous = useRef('');
  const threadsUrl = `/api/boards/${board.id}/chat/threads${task ? `?card_id=${task.id}` : ''}`;
  const scopeName = task?.title || board.name;
  const loadThreads = async () => { const t = await api.get(threadsUrl); setThreads(t); return t; };
  useEffect(() => {
    let active = true;
    api.get(threadsUrl).then(t => { if (active) { setThreads(t); setSelected(initialThreadId || t[0]?.id || ''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [board.id, task?.id, initialThreadId]);
  useEffect(() => {
    let active = true;
    setConversation(null);
    const load = async () => {
      try {
        const status = await api.get('/api/chat/status');
        if (!active) return;
        setCloud(!!status.cloud);setOnline(status.online);setPersonal(!!status.personal_ai);
        if (selected) {
          const data = await api.get(`/api/chat/threads/${selected}`);
          if (!active) return;
          setConversation(data);
          const key = data.job?.id + ':' + data.job?.status;
          if (key !== previous.current && data.job?.status === 'completed') onUpdated();
          previous.current = key;
        }
      } catch (e) { if (active) setError(e.message); }
    };
    load(); const timer = setInterval(load, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [selected, board.id]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [conversation?.messages?.length, conversation?.job?.draft]);
  const running = ['queued', 'running', 'recovering'].includes(conversation?.job?.status);
  const newThread = async () => {
    const t = await api.post(`/api/boards/${board.id}/chat/threads`, { title: 'New conversation', card_id: task?.id ?? null });
    await loadThreads(); setSelected(t.id); return t.id;
  };
  const send = async e => {
    e.preventDefault(); if (!mode || !input.trim() || running || busy) return;
    setBusy(true); setError('');
    try {
      const id = selected || await newThread();
      await api.post(`/api/chat/threads/${id}/messages`, { content: input.trim(), mode });
      setInput(''); setConversation(await api.get(`/api/chat/threads/${id}`)); await loadThreads();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <aside role="dialog" aria-label={`Codex chat for ${board.name}`} className="fixed right-0 top-0 bottom-0 w-full sm:w-[480px] z-40 flex flex-col border-l border-zinc-700 bg-zinc-950 shadow-2xl">
    <header className="p-4 border-b border-zinc-800 flex gap-3 items-center"><MessageSquare className="text-indigo-300" size={20} /><div className="flex-1 min-w-0"><h2 className="font-semibold">{personal?'AI':'Codex'} · {scopeName}</h2><p className="text-xs text-zinc-500">{task ? `${board.name} · Task #${task.id} · Saved task conversations` : 'Saved project conversations'}</p></div><button aria-label="Close project chat" onClick={onClose}><X size={20} /></button></header>
    <div className="p-3 flex gap-2 border-b border-zinc-800"><select aria-label="Conversation history" value={selected} onChange={e => { setSelected(e.target.value); setError(''); }} className="min-w-0 flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-2 py-2 text-sm"><option value="">New conversation</option>{threads.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select><button aria-label="Start new conversation" onClick={() => { setSelected(''); setConversation(null); setError(''); }} className="p-2 bg-zinc-800 rounded-lg"><Plus size={18} /></button></div>
    <div className={`px-4 py-2 text-xs border-b border-zinc-800 ${online ? 'text-emerald-300' : 'text-amber-300'}`}><span className="mr-2">●</span>{personal?(online?'Personal AI connection ready':'Add your AI key or billing to start'):(online?(cloud?'Cloud agents connected · your computer can be off':'Codex connected'):'Agent worker is offline · requests will wait')}{personal&&<button className="ml-3 underline" onClick={()=>window.dispatchEvent(new Event('boardly-account'))}>AI settings</button>}</div>
    <div className="flex-1 overflow-y-auto p-4 space-y-4" aria-live="polite">
      {!conversation?.messages?.length && <div className="py-8 text-sm text-zinc-500"><p className="text-zinc-300 mb-2">What should we work on in {scopeName}?</p><p>Ask Codex to review tasks, make changes or investigate a problem. {task ? 'This task has its own saved conversation and shares the project’s files.' : 'Your conversation stays with this project.'}</p></div>}
      {conversation?.messages?.map(m => <React.Fragment key={m.id}><article className={`rounded-xl p-3 ${m.role === 'user' ? 'bg-indigo-500/15 border border-indigo-500/20 ml-6' : 'bg-zinc-900 mr-3'}`}><p className="text-xs text-zinc-500 mb-2">{m.role === 'user' ? 'Member' : 'AI'} · {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p><div className="text-sm whitespace-pre-wrap break-words leading-relaxed">{m.content}</div></article>{(conversation.runs || (conversation.job ? [conversation.job] : [])).filter(r => r.message_id === m.id).map(run => <RunActivity key={run.id} run={run} online={online} />)}</React.Fragment>)}
      {conversation?.job?.mode==='work'&&['blocked','failed','interrupted'].includes(conversation.job.status)&&!readOnly&&<button type="button" className="rounded-lg border border-indigo-500 px-4 py-2 text-sm" onClick={async()=>{try{await api.post(`/api/chat/jobs/${conversation.job.id}/resume`,{content:input.trim()});setInput('');setConversation(await api.get(`/api/chat/threads/${selected}`));onUpdated();}catch(e){setError(e.message);}}}>Resume work</button>}
      <div ref={bottom} />
    </div>
    <form onSubmit={send} className="p-4 border-t border-zinc-800 space-y-2">
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <fieldset><legend className="text-xs text-zinc-400 mb-2">Choose a mode</legend><div className="flex gap-2">{[['ask','Ask'],['plan','Plan'],['work','Work']].map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} onClick={()=>setMode(value)} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${mode===value?'border-indigo-400 bg-indigo-500/20':'border-zinc-700'}`}>{label}</button>)}</div><p className="text-xs text-zinc-500 mt-2">{mode==='work'?'Work can edit this project and run tools.':mode==='plan'?'Discuss a plan and clarify the next steps. No actions.':mode==='ask'?'Ask questions and explore ideas. No actions.':'Ask for answers, Plan before acting, or Work to execute.'}</p></fieldset>
      <textarea disabled={readOnly} aria-label="Message Codex" value={input} onChange={e => setInput(e.target.value)} maxLength={30000} rows={3} placeholder={`Ask Codex about ${board.name}…`} className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm resize-none focus:border-indigo-400 outline-none" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }} />
      <div className="flex justify-between items-center"><span className="text-xs text-zinc-600">Ctrl / ⌘ + Enter to send</span>{running&&!readOnly ? <button type="button" onClick={async () => { try { await api.post(`/api/chat/jobs/${conversation.job.id}/cancel`, {}); setConversation(await api.get(`/api/chat/threads/${selected}`)); } catch (e) { setError(e.message); } }} className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-zinc-800"><Square size={14} /> Stop</button> : <button disabled={!mode || !input.trim() || busy || readOnly || (personal&&!online)} className="flex items-center gap-2 text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-40"><Send size={15} />{busy ? 'Sending…' : mode==='work'?'Start work':mode==='plan'?'Discuss plan':'Ask AI'}</button>}</div>
    </form>
  </aside>;
}
