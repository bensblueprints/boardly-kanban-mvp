import React, {useEffect,useState} from 'react';
import {api} from '../api.js';
const input = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm';
const button = 'rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50';
const blank = {label:'',email:'',host:'',port:993,username:'',password:'',allow_agent:false};
export default function CompanyEmails({companyId}) {
  const [accounts,setAccounts]=useState([]), [form,setForm]=useState(null), [busy,setBusy]=useState(false), [notice,setNotice]=useState(''), [error,setError]=useState('');
  const [inbox,setInbox]=useState(null), [message,setMessage]=useState(null);
  const base=`/api/companies/${companyId}/emails`;
  const load=()=>api.get(base).then(setAccounts);
  useEffect(()=>{setInbox(null);setMessage(null);setForm(null);load().catch(e=>setError(e.message));},[companyId]);
  async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function save(e){e.preventDefault();await act(async()=>{
    const data={...form,port:Number(form.port),username:form.username || form.email};
    if(form.id) await api.patch(`${base}/${form.id}`,data);else await api.post(base,data);
    setForm(null);setNotice('Email saved. Test the connection to check inbox access.');await load();
  });}
  return <section className="space-y-5">
    <div className="flex justify-between gap-3 items-start"><div><h2 className="font-semibold text-lg">Company emails</h2><p className="text-sm text-zinc-400 mt-1">Connect the inboxes used by this company. Enable agent access to let its projects read messages and retrieve sign-in codes.</p></div><button className={button+' shrink-0'} onClick={()=>{setForm({...blank});setError('');}}>Add email</button></div>
    {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-300">{notice}</p>}
    {form&&<form onSubmit={save} className="rounded-xl border border-indigo-500/40 bg-zinc-900 p-5 space-y-4">
      <h3 className="font-semibold">{form.id?'Edit email':'Connect email'}</h3>
      <div className="grid sm:grid-cols-2 gap-4">{[['label','Label','text','Operations'],['email','Email address','email','team@company.com'],['host','IMAP server','text','imap.example.com'],['port','TLS port','number','993'],['username','IMAP username','text','Defaults to email address'],['password',form.id?'New app password (leave blank to keep)':'App password','password','']].map(([key,label,type,placeholder])=><label key={key} className="text-sm text-zinc-300 space-y-1 block"><span>{label}</span><input className={input} type={type} autoComplete={type==='password'?'new-password':'off'} value={form[key]} placeholder={placeholder} required={!['username','password'].includes(key)||key==='password'&&!form.id} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}</div>
      <p className="text-xs text-zinc-400">Use your provider’s IMAP settings and an app password. Connections use TLS. Passwords are encrypted and never included in project chat. Inbox messages are read without marking them read.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!form.allow_agent} onChange={e=>setForm({...form,allow_agent:e.target.checked})}/>Allow agents in this company to read this inbox and retrieve verification codes</label>
      <div className="flex gap-2"><button disabled={busy} className={button+' bg-indigo-600'}>{busy?'Saving…':'Save email'}</button><button type="button" className={button} onClick={()=>setForm(null)}>Cancel</button></div>
    </form>}
    {!accounts.length&&!form&&<div className="rounded-xl border border-dashed border-zinc-700 p-8 text-zinc-400 text-sm">No emails connected. Add a company inbox to use it across this company’s projects.</div>}
    <div className="space-y-3">{accounts.map(a=><article key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap justify-between gap-4"><div><h3 className="font-semibold">{a.label}</h3><p className="text-sm text-zinc-300">{a.email}</p><p className="text-xs text-zinc-500 mt-1">{a.tested_at?`Connected · tested ${new Date(a.tested_at).toLocaleString()}`:'Connection not tested'} · {a.allow_agent?'Agent access enabled':'Agent access off'}</p></div>
      <div className="flex flex-wrap gap-2 items-start"><button disabled={busy} className={button} onClick={()=>act(async()=>{await api.post(`${base}/${a.id}/test`);await load();setNotice(`${a.label}: connected to inbox.`);})}>Test connection</button><button disabled={busy} className={button} onClick={()=>act(async()=>{const r=await api.post(`${base}/${a.id}/list`);setInbox({account:a,...r});setMessage(null);})}>Open inbox</button><button className={button} onClick={()=>setForm({...a,password:''})}>Edit</button><button disabled={busy} className={button} onClick={()=>act(async()=>{if(!confirm(`Remove ${a.email} from this company?`))return;await api.del(`${base}/${a.id}`);if(inbox?.account.id===a.id){setInbox(null);setMessage(null);}await load();})}>Remove</button></div></div>
    </article>)}</div>
    {busy&&<p role="status" className="text-sm text-indigo-300">Connecting to email…</p>}
    {inbox&&<div className="rounded-xl border border-zinc-700 overflow-hidden"><div className="p-4 border-b border-zinc-800 flex justify-between"><h3 className="font-semibold">Inbox · {inbox.account.email}</h3><button className="text-sm text-zinc-400" onClick={()=>{setInbox(null);setMessage(null);}}>Close inbox</button></div>
      <div className="grid md:grid-cols-2"><div className="max-h-[32rem] overflow-auto">{!inbox.messages.length&&<p className="p-4 text-zinc-400 text-sm">Inbox is empty.</p>}{inbox.messages.map(m=><button disabled={busy} key={m.uid} className="w-full text-left p-4 border-b border-zinc-800 hover:bg-zinc-800" onClick={()=>act(async()=>setMessage(await api.post(`${base}/${inbox.account.id}/read`,{uid:m.uid,uid_validity:m.uid_validity})))}><p className="text-sm font-medium break-words">{m.subject||'(No subject)'}</p><p className="text-xs text-zinc-400 break-all mt-1">{m.from.join(', ')}</p><p className="text-xs text-zinc-500">{m.date?new Date(m.date).toLocaleString():''}</p></button>)}</div><div className="p-4 border-l border-zinc-800 max-h-[32rem] overflow-auto">{message?<><h4 className="font-semibold mb-3">{message.subject}</h4><pre className="whitespace-pre-wrap break-words font-sans text-sm text-zinc-300">{message.text}</pre></>:<p className="text-sm text-zinc-500">Select an email to read it.</p>}</div></div>
    </div>}
  </section>;
}
