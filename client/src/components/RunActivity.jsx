import React, { useEffect, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

export default function RunActivity({ run, online }) {
  const live = ['queued', 'running', 'recovering'].includes(run.status);
  const [open, setOpen] = useState(live), [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const elapsed = duration((live ? now : run.updated_at) - (run.started_at || run.created_at));
  const contactAge = now - run.updated_at;
  const activities = run.activity || [];
  const feed = useRef(null), following = useRef(true);
  const lastActivity = activities.reduce((latest, a) => Math.max(latest, a.updated_at), run.started_at || run.created_at);
  useEffect(() => {
    if (feed.current && following.current && live) feed.current.scrollTop = feed.current.scrollHeight;
  }, [activities.length, lastActivity, open, live]);
  const failed = ['failed', 'interrupted', 'cancelled', 'blocked'].includes(run.status);
  const queueReason = {
    project_work: 'Another Work conversation is changing this project. This request will start when it finishes. Ask and Plan chats can run alongside it when an agent is available.',
    conversation: 'An earlier request in this conversation is still active. Open a new chat to discuss something else.',
    stopping: 'A previous run is still stopping. This request will start after the worker confirms it has stopped.',
    capacity: 'All four agents are busy. This request will start when an agent becomes available.',
    ready: 'Ready to start. Waiting for the next available agent.'
  }[run.queue?.reason] || 'Waiting for an available agent to start this request.';
  const title = run.status === 'queued' ? run.queue?.reason === 'project_work' ? 'Waiting for this project’s Work chat' : run.queue?.reason === 'stopping' ? 'Waiting for previous run to stop' : 'Queued' : run.status === 'running' ? run.progress || 'Codex is working' : run.status === 'completed' ? 'Work completed' : run.status==='blocked'?'Blocked · action needed':run.status==='recovering'?'Recovering cloud assignment':run.status === 'cancelled' ? 'Run stopped' : 'Run did not finish';
  // The completed answer is already rendered as a chat message.
  const visible = activities.filter(a => !(run.status === 'completed' && a.kind === 'update' && a.detail === run.draft));
  return <section aria-label="Codex activity" className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden mr-3">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="w-full flex gap-2 items-start text-left p-3">
      {live ? <LoaderCircle size={16} className="text-indigo-300 animate-spin shrink-0 mt-0.5" /> : failed ? <CircleAlert size={16} className="text-amber-300 shrink-0 mt-0.5" /> : <Check size={16} className="text-emerald-300 shrink-0 mt-0.5" />}
      <span className="flex-1 min-w-0"><span className="block text-sm text-zinc-200 break-words">{run.mode&&<span className="text-xs text-indigo-300 mr-2">{run.mode==='work'?'Work':run.mode==='plan'?'Plan':'Ask'}</span>}{title}</span><span className="block text-xs text-zinc-500 mt-1">{run.worker_host==='cloud'?'Cloud · ':''}{run.continuation_count>1?`${run.continuation_count} working sessions · `:''}{elapsed} {run.status === 'queued' ? 'waiting' : 'elapsed'} · {visible.length} activities</span></span>
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
    </button>
    {live && <div className={`px-3 pb-3 text-xs ${run.status === 'running' && contactAge > 15000 ? 'text-amber-300' : 'text-zinc-400'}`}>
      {run.status === 'queued' ? online ? queueReason : 'The agent worker is offline. This request is saved in the queue.' : <><span className="block">{contactAge > 15000 ? 'Worker disconnected — this run will continue when it reconnects' : 'Worker connected'} · last contact {duration(contactAge)} ago</span><span className="block mt-1">Last activity {duration(now - lastActivity)} ago{now - lastActivity > 30000 ? ' · no new activity reported yet' : ''}</span></>}
    </div>}
    {open && <div ref={feed} onScroll={e => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} className="max-h-80 overflow-y-auto border-t border-zinc-800 px-3 py-2 space-y-3">
      {visible.map(a => <div key={a.key} className="flex items-start gap-2 text-sm">
        {a.status === 'running' && live ? <LoaderCircle size={14} className="mt-1 shrink-0 text-indigo-300 animate-spin" /> : a.status === 'failed' || (a.status === 'running' && !live) ? <CircleAlert size={14} className="mt-1 shrink-0 text-amber-300" /> : a.kind === 'update' ? <Activity size={14} className="mt-1 shrink-0 text-indigo-300" /> : <Check size={14} className="mt-1 shrink-0 text-emerald-400" />}
        <div className="min-w-0 flex-1"><div className="flex gap-2 justify-between"><span className="text-zinc-300 break-words">{a.title}</span><time className="text-zinc-600 text-xs shrink-0 mt-0.5">{new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>{a.detail && <p className={`mt-1 whitespace-pre-wrap break-words leading-relaxed ${a.kind === 'update' ? 'text-zinc-200' : 'text-xs text-zinc-400'}`}>{a.detail}</p>}</div>
      </div>)}
      {!visible.length && <p className="text-xs text-zinc-500">{live ? 'Activity will appear here as Codex reports it.' : 'No activity details were recorded for this run.'}</p>}
      {live && !activities.some(a => a.kind === 'update') && run.draft && <p className="text-sm whitespace-pre-wrap break-words">{run.draft}</p>}
    </div>}
    {failed && <p className="p-3 border-t border-zinc-800 text-sm text-amber-300">{run.blocker?`${run.blocker} Next action: ${run.next_action}`:run.error || (run.status === 'cancelled' ? 'Changes already made are retained.' : 'Send another message to continue.')}</p>}
  </section>;
}
