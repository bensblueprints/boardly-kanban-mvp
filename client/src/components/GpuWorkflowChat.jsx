import React, {useEffect, useRef, useState} from 'react';
import {MessageSquare, Send, Plus, Pencil, Check, RefreshCw, ArrowDown} from 'lucide-react';
import {api} from '../api.js';

const base='/api/gpu/workflow-chats';
const labels={prompt:'AI prompt',image:'Create image',video:'Create video',email:'Email output',social:'Post to social media',action:'Project action'};

export default function GpuWorkflowChat({chatId,workflows,templates,projects,onSelect,onSaved,Editor}) {
  const [chat,setChat]=useState(null),[chats,setChats]=useState([]),[message,setMessage]=useState('');
  const [workflow,setWorkflow]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [notice,setNotice]=useState(''),[editing,setEditing]=useState(false);
  const request=useRef(null),saveRequest=useRef(null),creating=useRef(null),log=useRef(null),composer=useRef(null);
  const active=useRef(chatId);
  const editingRef=useRef(editing);editingRef.current=editing;
  const pending=chat?.turns.some(t=>['queued','running'].includes(t.status));
  const last=chat?.turns.at(-1);
  const refreshList=()=>api.get(base).then(d=>setChats(d.chats));

  useEffect(()=>{
    active.current=chatId;
    let alive=true;
    setChat(null);setError('');setNotice('');setEditing(false);setMessage('');request.current=null;saveRequest.current=null;
    refreshList().catch(e=>{if(alive)setError(e.message);});
    const load=async()=>{
      if(!chatId)return;
      try{const next=await api.get(base+'/'+chatId);if(alive&&!editingRef.current)setChat(next);}
      catch(e){if(alive)setError(e.message);}
    };
    load();const timer=setInterval(load,2500);
    return()=>{alive=false;clearInterval(timer);};
  },[chatId]);
  useEffect(()=>{if(log.current)log.current.scrollTop=log.current.scrollHeight;},[chat?.turns.length,last?.status]);

  async function send(event) {
    event?.preventDefault();const content=message.trim();if(!content||busy||pending||editing||(chatId&&!chat))return;
    setBusy('send');setError('');setNotice('');
    try {
      let current=chat;
      if(!current){
        creating.current ||= crypto.randomUUID();
        current=await api.post(base,{request_id:creating.current,...(workflow?{workflow_id:workflow}:{})});
        creating.current=null;active.current=current.id;onSelect(current.id);setChat(current);
      }
      const identity=current.id;
      if(!request.current||request.current.content!==content||request.current.chat!==identity)request.current={id:crypto.randomUUID(),content,chat:identity};
      const result=await api.post(base+'/'+identity+'/messages',{client_id:request.current.id,version:current.version,content});
      if(active.current===identity){setChat(result);setMessage('');request.current=null;}
      refreshList().catch(()=>{});
    } catch(e){setError(e.message);setMessage(content);}
    finally{setBusy('');composer.current?.focus();}
  }
  async function retry() {
    setBusy('retry');setError('');
    try{setChat(await api.post(base+'/'+chat.id+'/retry',{turn_id:last.id,version:chat.version}));}
    catch(e){setError(e.message);}finally{setBusy('');}
  }
  async function save(definition=chat.draft,asNew=false) {
    setBusy('save');setError('');setNotice('');
    const key=JSON.stringify([chat.id,chat.version,definition,asNew]);
    if(saveRequest.current?.key!==key)saveRequest.current={key,id:crypto.randomUUID()};
    try {
      const result=await api.post(base+'/'+chat.id+'/apply',{request_id:saveRequest.current.id,version:chat.version,definition,as_new:asNew});
      setChat(result.chat);setEditing(false);setNotice('Workflow saved. You can run it from Workflows.');saveRequest.current=null;
      await onSaved();await refreshList();
    } catch(e){setError(e.message);}finally{setBusy('');}
  }
  const locked=!!busy||pending;
  return <section className="gpu-workflow-chat gpu-stack" aria-label="Workflow chat">
    <div className="gpu-row gpu-chat-heading"><div><h2>Chat with Boardly</h2><p>Describe a new workflow or tell Boardly what to change.</p></div>
      <button disabled={!!busy} onClick={()=>{onSelect(null);setWorkflow('');creating.current=null;}}><Plus size={17} aria-hidden="true"/>New conversation</button>
    </div>
    <div className="gpu-form-grid">
      <div className="gpu-field"><label htmlFor="gpu-chat-history">Saved conversations</label><select id="gpu-chat-history" value={chatId||''} disabled={!!busy} onChange={e=>onSelect(e.target.value||null)}><option value="">New conversation</option>{chats.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      {!chatId&&<div className="gpu-field"><label htmlFor="gpu-chat-target">Workflow to build or edit</label><select id="gpu-chat-target" value={workflow} disabled={locked} onChange={e=>{setWorkflow(e.target.value);creating.current=null;}}><option value="">Create a new workflow</option>{workflows.map(w=><option value={w.id} key={w.id}>Edit: {w.name}</option>)}</select></div>}
    </div>
    {error&&<div className="gpu-error" role="alert">{error}<button disabled={locked} onClick={async()=>{try{if(chatId)setChat(await api.get(base+'/'+chatId));setError('');}catch(e){setError(e.message);}}}><RefreshCw size={15} aria-hidden="true"/>Reload conversation</button></div>}
    {notice&&<p role="status" className="gpu-success"><Check size={16} aria-hidden="true"/>{notice}</p>}
    <div className="gpu-chat-layout">
      <div className="gpu-panel gpu-chat-conversation">
        <div className="gpu-chat-messages" ref={log} role="log" aria-label="Messages with Boardly" aria-live="polite" aria-relevant="additions text">
          {!chat?.turns.length&&<div className="gpu-chat-intro"><MessageSquare size={28} aria-hidden="true"/><h3>{workflow||chat?.workflow_id?'What would you like to change?':'What would you like your GPUs to do?'}</h3><p>For example, turn an idea into an image, write a caption, then hand the files to a project.</p><p className="gpu-small">Boardly uses your saved generation templates and connected AI account. You can review and edit the draft before saving.</p></div>}
          {chat?.turns.map(t=><React.Fragment key={t.id}>
            <article className="gpu-chat-message gpu-chat-user"><strong>You</strong><p>{t.prompt}</p></article>
            {t.reply&&<article className="gpu-chat-message gpu-chat-assistant"><strong>Boardly</strong><p>{t.reply}</p></article>}
            {['queued','running'].includes(t.status)&&<p role="status" className="gpu-chat-thinking">Boardly is building your workflow…</p>}
            {t.status==='failed'&&<div className="gpu-error" role="alert"><span>{t.error}</span>{last?.id===t.id&&<button disabled={locked} onClick={retry}>{busy==='retry'?'Retrying…':'Retry reply'}</button>}</div>}
          </React.Fragment>)}
        </div>
        {!pending&&!editing&&last?.suggestions.length>0&&<div className="gpu-actions gpu-chat-suggestions">{last.suggestions.map(s=><button key={s} disabled={!!busy} onClick={()=>{setMessage(s);composer.current?.focus();}}>{s}</button>)}</div>}
        <form className="gpu-chat-composer" onSubmit={send}>
          <label htmlFor="gpu-chat-message">Message Boardly</label>
          <textarea id="gpu-chat-message" ref={composer} required rows={3} maxLength={6000} value={message} disabled={editing||!!chatId&&!chat} placeholder="Build me a workflow that…" onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.nativeEvent.isComposing){e.preventDefault();send();}}}/>
          <div className="gpu-row"><span className="gpu-small">{editing?'Finish editing the draft to continue chatting.':'Ctrl / ⌘ + Enter to send'}</span><button className="gpu-primary" disabled={locked||editing||!message.trim()||!!chatId&&!chat} type="submit"><Send size={16} aria-hidden="true"/>{busy==='send'?'Sending…':'Send message'}</button></div>
        </form>
      </div>
      <aside className="gpu-panel gpu-stack gpu-chat-draft" aria-label="Proposed workflow">
        <div><p className="gpu-eyebrow">WORKFLOW DRAFT</p><h3>{chat?.draft?.name||'Your steps will appear here'}</h3><p className="gpu-small">Saving updates the workflow definition. Use Run with a prompt when you’re ready to execute it.</p></div>
        {chat?.draft?<>
          <ol className="gpu-chat-step-list">{chat.draft.steps.map((step,index)=>{
            const template=templates.find(t=>t.id===step.template_id),project=projects.find(p=>p.id===step.project_id);
            return <li key={index}><div className="gpu-step-title"><span className="gpu-step-number">{index+1}</span><strong>{labels[step.kind]}</strong></div>{template&&<p className="gpu-small">{template.name} · {template.worker_name}</p>}{project&&<p className="gpu-small">{project.company_name?project.company_name+' / ':''}{project.name}</p>}<p className="gpu-pre">{step.prompt}</p>{index<chat.draft.steps.length-1&&<ArrowDown size={16} aria-hidden="true"/>}</li>;
          })}</ol>
          {chat.saved_version===chat.version&&<p className="gpu-success" role="status"><Check size={16} aria-hidden="true"/>This draft is saved.</p>}
          <div className="gpu-actions"><button className="gpu-primary" disabled={locked||editing||chat.saved_version===chat.version} onClick={()=>save()}>{busy==='save'?'Saving…':chat.workflow_id?'Save changes':'Save new workflow'}</button><button disabled={locked||editing} onClick={()=>setEditing(true)}><Pencil size={15} aria-hidden="true"/>Edit draft</button>{chat.workflow_id&&<button disabled={locked||editing} onClick={()=>save(chat.draft,true)}>Save as new workflow</button>}</div>
          <p className="gpu-small">Continue chatting to refine these steps.</p>
        </>:<p>Add a message to get a proposed sequence using your available GPUs and templates.</p>}
      </aside>
    </div>
    {editing&&chat?.draft&&<Editor key={chat.id+':'+chat.version} definition={chat.draft} templates={templates} projects={projects} busy={busy==='save'} onClose={()=>setEditing(false)} onSave={value=>save(value)}/>}
  </section>;
}
