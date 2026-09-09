import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Send, Square, MessageSquare, Maximize2, Minimize2, Headphones } from 'lucide-react';
import { api } from '../api.js';
import RunActivity from './RunActivity.jsx';
import GithubConnection from './GithubConnection.jsx';
import AudioBriefing from './AudioBriefing.jsx';
import SshConnections from './SshConnections.jsx';

export default function ProjectChat({ board, task = null, onClose, onUpdated, initialThreadId = null }) {
  const readOnly=board.permissions?.role==='viewer';
  const [audioOpen,setAudioOpen]=useState(false),[sshOpen,setSshOpen]=useState(false);
  const [funding,setFunding]=useState('');
  const [context,setContext]=useState(null),[githubOpen,setGithubOpen]=useState(false);
  const [personal,setPersonal]=useState(false),[cloud,setCloud]=useState(false),[mode,setMode]=useState('');
  const [threads, setThreads] = useState([]), [selected, setSelected] = useState('');
  const [conversation, setConversation] = useState(null), [online, setOnline] = useState(false);
  const [input, setInput] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const pane = useRef(null);
  const messages = useRef(null), previous = useRef('');
  const threadsUrl = `/api/boards/${board.id}/chat/threads${task ? `?card_id=${task.id}` : ''}`;
  const scopeName = task?.title || board.name;
  const loadThreads = async () => { const t = await api.get(threadsUrl); setThreads(t); return t; };
  const startConversation = () => { setSelected(''); setConversation(null); setMode('ask'); setError(''); };
  useEffect(() => {
    if (!maximized) return;
    if (!pane.current.contains(document.activeElement)) pane.current.querySelector('button')?.focus();
    // Keep the mounted chat and its draft while making the covered workspace inert.
    const background = [];
    for (let node = pane.current; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          background.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const restore = () => setMaximized(false);
    window.addEventListener('boardly-account', restore);
    return () => {
      window.removeEventListener('boardly-account', restore);
      background.forEach(([element, inert]) => { element.inert = inert; });
      document.body.style.overflow = overflow;
    };
  }, [maximized]);
  function handleWindowKey(event) {
    if (!maximized || event.target.closest('dialog[open]')) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault(); setMaximized(false);
    } else if (event.key === 'Tab') {
      const controls = [...pane.current.querySelectorAll('button, select, textarea, input, a[href], [tabindex]')]
        .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  useEffect(() => {
    let active = true;
    api.get(threadsUrl).then(t => { if (active) { setThreads(t); setSelected(initialThreadId || t[0]?.id || ''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [board.id, task?.id, initialThreadId]);
  useEffect(() => {
    let active = true,loading=false;
    setConversation(null);
    setContext(null);
    const load = async () => {
      if(loading)return;loading=true;
      try {
        const [status,projectContext,history] = await Promise.all([api.get('/api/chat/status'),api.get(`/api/boards/${board.id}/chat/context`),api.get(threadsUrl)]);
        if (!active) return;
        setThreads(history);setContext(projectContext);if(!projectContext.can_manage_ssh)setSshOpen(false);if(!projectContext.can_manage_github)setGithubOpen(false);
        setCloud(!!status.cloud);setOnline(status.online);setPersonal(!!status.personal_ai);setFunding(status.funding||'');
        if (selected) {
          const data = await api.get(`/api/chat/threads/${selected}`);
          if (!active) return;
          setConversation(data);
          const key = data.job?.id + ':' + data.job?.status;
          if (key !== previous.current && data.job?.status === 'completed') onUpdated();
          previous.current = key;
        }
      } catch (e) { if (active){setError(e.message);if([401,403,404].includes(e.status)){setContext(null);setGithubOpen(false);setSshOpen(false);}} }
      finally{loading=false;}
    };
    load(); const timer = setInterval(load, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [selected, board.id, task?.id]);
  useEffect(() => { messages.current?.scrollTo({ top: messages.current.scrollHeight, behavior: 'smooth' }); }, [conversation?.messages?.length, conversation?.job?.draft]);
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
  return <aside ref={pane} role="dialog" aria-label={`Codex chat for ${board.name}`} aria-modal={maximized} onKeyDown={handleWindowKey} className={`coding-pane ${maximized ? 'coding-pane-maximized' : ''} h-full min-h-0 min-w-0 flex flex-col overflow-y-auto bg-zinc-950`}>
    <header className="shrink-0 p-4 border-b border-zinc-800 flex gap-3 items-center"><MessageSquare className="shrink-0 text-indigo-300" size={20} /><div className="flex-1 min-w-0"><h2 className="font-semibold">{personal?'AI':'Codex'} · {scopeName}</h2><p className="text-xs text-zinc-500">{task ? `${board.name} · Task #${task.id} · Saved task conversations` : 'Saved project conversations'}</p></div><button type="button" aria-label={maximized ? 'Restore chat window' : 'Maximize chat window'} title={maximized ? 'Restore chat window (Esc)' : 'Maximize chat window'} onClick={() => setMaximized(value => !value)} className="shrink-0 flex items-center gap-1.5 rounded-lg p-2 text-sm text-zinc-300 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-indigo-400">{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}<span>{maximized ? 'Restore' : 'Maximize'}</span></button><button aria-label="Close project chat" title="Close project chat" onClick={onClose} className="shrink-0 rounded-lg p-2 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-indigo-400"><X size={20} /></button></header>
    <div className="shrink-0 px-4 py-2 border-b border-zinc-800"><button disabled={readOnly} title={readOnly?'Audio requires Editor access to this project':'Hear priorities, blockers and next steps'} className="flex items-center gap-2 rounded-lg border border-indigo-400 px-3 py-2 text-sm text-indigo-100 disabled:opacity-40" onClick={()=>setAudioOpen(true)}><Headphones size={17}/>Audio briefing</button></div>
    {audioOpen&&<AudioBriefing kind="project" id={board.id} onClose={()=>setAudioOpen(false)}/>}
    <div className="shrink-0 p-3 flex gap-2 border-b border-zinc-800"><select aria-label="Conversation history" disabled={busy} value={selected} onChange={e => { if (!e.target.value) startConversation(); else { setSelected(e.target.value); setError(''); } }} className="min-w-0 flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-2 py-2 text-sm"><option value="">New conversation</option>{threads.map(t => <option key={t.id} value={t.id}>{t.title}{['queued','running','recovering','blocked'].includes(t.job_status)?` · ${t.job_mode==='work'?'Work':t.job_mode==='plan'?'Plan':'Ask'} ${t.job_status}`:''}</option>)}</select>{!readOnly&&<button type="button" aria-label="Start new conversation" title="New chat in Ask mode" disabled={busy} onClick={startConversation} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-sm disabled:opacity-40"><Plus size={18} />New chat</button>}</div>
    <div className={`shrink-0 px-4 py-2 text-xs border-b border-zinc-800 ${online ? 'text-emerald-300' : 'text-amber-300'}`}><span className="mr-2">●</span>{personal?(online?(funding==='owner_subscription'?'Company owner’s subscription connected':funding==='owner_chatgpt'?'Company owner’s ChatGPT connected':'Company owner funds AI usage'):'Ask the company owner to reconnect AI funding'):(online?(cloud?'Cloud agents connected · your computer can be off':'Codex connected'):'Agent worker is offline · requests will wait')}{personal&&board.permissions?.owner!==false&&<button className="ml-3 underline" onClick={()=>window.dispatchEvent(new Event('boardly-account'))}>AI settings</button>}</div>
    {context&&<div aria-label="Saved GitHub connection" className="shrink-0 px-4 py-3 text-xs border-b border-zinc-800 space-y-1"><p className="text-zinc-300 break-words">{context.github.saved?`GitHub: ${context.github.repository} · ${context.github.branch}`:context.github.status==='restricted'?'GitHub access is managed by the company owner.':'No GitHub connection saved for this project.'}</p>{context.github.saved&&<p className="text-zinc-500">{context.github.inherited?'Inherited from company':'Saved to project'} · Available across this project’s chats{!context.github.allow_agent?' · Agent access paused':''}</p>}{context.github.status==='needs_token'&&<p className="text-amber-200">Account GitHub PAT needed.{board.permissions?.owner!==false?<button className="ml-2 underline" onClick={()=>window.dispatchEvent(new CustomEvent('boardly-account',{detail:{section:'github'}}))}>Set up account GitHub PAT</button>:' Ask the company owner to add it.'}</p>}{context.can_manage_github&&<button aria-expanded={githubOpen} onClick={()=>{setSshOpen(false);setGithubOpen(!githubOpen);}} className="text-indigo-300 underline">{githubOpen?'Close GitHub settings':context.github.saved?'GitHub settings':'Connect GitHub'}</button>}</div>}
    {context?.ssh&&<details aria-label="Saved SSH connections" className="shrink-0 px-4 py-2 text-xs border-b border-zinc-800 text-zinc-300"><summary className="cursor-pointer">{context.ssh.status==='restricted'?'SSH access is managed by the company owner':context.ssh.saved?`SSH: ${context.ssh.connections.filter(c=>c.allow_agent).length} enabled · ${context.ssh.connections.filter(c=>c.source==='account').length} shared from account`:'No SSH connections saved for this project'}</summary><div className="mt-2 space-y-2">{context.ssh.connections.map(c=><p key={c.id}>{c.label} · {c.source==='account'?'All companies and projects':c.source==='company'?'From company':'This project'} · {c.allow_agent?'Work enabled':'Agent access paused'}</p>)}<p className="text-zinc-500">Use Work mode to connect. Ask and Plan can discuss saved connections.</p>{context.can_manage_ssh&&<button className="text-indigo-300 underline" onClick={()=>{setGithubOpen(false);setSshOpen(!sshOpen);}}>{sshOpen?'Close SSH settings':'SSH settings'}</button>}</div></details>}
    {sshOpen&&context?.can_manage_ssh?<div className="flex-1 min-h-36 overflow-y-auto p-4"><SshConnections key={board.id} kind="projects" id={board.id}/></div>:githubOpen&&context?.can_manage_github?<div className="flex-1 min-h-36 overflow-y-auto p-4"><GithubConnection key={board.id} kind="projects" id={board.id}/></div>:<>
    <div ref={messages} className="flex-1 min-h-36 overflow-y-auto p-4 space-y-4" aria-live="polite">
      {!conversation?.messages?.length && <div className="py-8 text-sm text-zinc-500"><p className="text-zinc-300 mb-2">What should we work on in {scopeName}?</p><p>Ask Codex to review tasks, make changes or investigate a problem. {task ? 'This task has its own saved conversation and shares the project’s files.' : 'Your conversation stays with this project.'}</p></div>}
      {conversation?.messages?.map(m => <React.Fragment key={m.id}><article className={`rounded-xl p-3 ${m.role === 'user' ? 'bg-indigo-500/15 border border-indigo-500/20 ml-6' : 'bg-zinc-900 mr-3'}`}><p className="text-xs text-zinc-500 mb-2">{m.role === 'user' ? 'Member' : 'AI'} · {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p><div className="text-sm whitespace-pre-wrap break-words leading-relaxed">{m.content.split('\n\nVoice briefing instructions:')[0]}</div></article>{(conversation.runs || (conversation.job ? [conversation.job] : [])).filter(r => r.message_id === m.id).map(run => <RunActivity key={run.id} run={run} online={online} />)}</React.Fragment>)}
      {conversation?.job?.mode==='work'&&['blocked','failed','interrupted'].includes(conversation.job.status)&&!readOnly&&<button type="button" className="rounded-lg border border-indigo-500 px-4 py-2 text-sm" onClick={async()=>{try{await api.post(`/api/chat/jobs/${conversation.job.id}/resume`,{content:input.trim()});setInput('');setConversation(await api.get(`/api/chat/threads/${selected}`));onUpdated();}catch(e){setError(e.message);}}}>Resume work</button>}
    </div>
    <form onSubmit={send} className="shrink-0 p-4 border-t border-zinc-800 space-y-2">
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {running&&!readOnly&&<div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-100"><p>This conversation is {conversation.job.status}. You can open another chat while it continues.</p><button type="button" disabled={busy} onClick={startConversation} className="mt-2 underline disabled:opacity-40">Ask in a new chat</button></div>}
      <fieldset><legend className="text-xs text-zinc-400 mb-2">Choose a mode</legend><div className="flex gap-2">{[['ask','Ask'],['plan','Plan'],['work','Work']].map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} onClick={()=>setMode(value)} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${mode===value?'border-indigo-400 bg-indigo-500/20':'border-zinc-700'}`}>{label}</button>)}</div><p className="text-xs text-zinc-500 mt-2">{mode==='work'?'Work can edit files and run tools. One Work chat runs per project at a time to prevent conflicting changes.':mode==='plan'?'Discuss a plan without making changes. Separate Ask and Plan chats can run alongside Work when an agent is available.':mode==='ask'?'Ask questions without making changes. Separate Ask and Plan chats can run alongside Work when an agent is available.':'Ask for answers, Plan before acting, or Work to execute.'}</p></fieldset>
      <textarea disabled={readOnly} aria-label="Message Codex" value={input} onChange={e => setInput(e.target.value)} maxLength={30000} rows={3} placeholder={`Ask Codex about ${board.name}…`} className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm resize-none focus:border-indigo-400 outline-none" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }} />
      <div className="flex justify-between items-center"><span className="text-xs text-zinc-600">Ctrl / ⌘ + Enter to send</span>{running&&!readOnly ? <button type="button" onClick={async () => { try { await api.post(`/api/chat/jobs/${conversation.job.id}/cancel`, {}); setConversation(await api.get(`/api/chat/threads/${selected}`)); } catch (e) { setError(e.message); } }} className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-zinc-800"><Square size={14} /> Stop</button> : <button disabled={!mode || !input.trim() || busy || readOnly || (personal&&!online)} className="flex items-center gap-2 text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-40"><Send size={15} />{busy ? 'Sending…' : mode==='work'?'Start work':mode==='plan'?'Discuss plan':'Ask AI'}</button>}</div>
    </form>
    </>}
  </aside>;
}
