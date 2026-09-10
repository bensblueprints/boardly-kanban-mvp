import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
const button='rounded-lg border border-zinc-600 px-4 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export default function ChatGPTConnection({onChange,ownerSubscription=false}){
 const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reply,setReply]=useState('');
 const activating=useRef(false),alive=useRef(true),changed=useRef(onChange);changed.current=onChange;
 async function refresh(){const value=await api.get('/api/ai/chatgpt');if(!alive.current)return;setState(value);if(value.connected&&activating.current){activating.current=false;await api.post('/api/ai/chatgpt/activate');if(alive.current){setState({...value,active:true});changed.current?.();}}return value;}
 useEffect(()=>{alive.current=true;refresh().catch(e=>setError(e.message));return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!state?.pending)return;const timer=setInterval(()=>refresh().catch(e=>{if(alive.current)setError(e.message);}),2500);return()=>clearInterval(timer);},[state?.pending?.login_id]);
 async function act(action){setBusy(true);setError('');setReply('');try{
  if(action==='login')activating.current=true;
  if(action==='cancel'||action==='disconnect')activating.current=false;
  const value=await api.post('/api/ai/chatgpt/'+action);
  if(!alive.current)return;
  if(value.reply)setReply(value.reply);
  await refresh();changed.current?.();
 }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}}
 return <section aria-label="ChatGPT connection" className="rounded-xl border border-indigo-500/40 bg-indigo-950/20 p-4 space-y-4">
 <div><h3 className="font-semibold text-lg">Use your ChatGPT account</h3><p className="text-sm text-zinc-300 mt-2">Connect the ChatGPT account you already use. No OpenAI API key or Boardly AI usage card is needed. Your ChatGPT plan’s Codex access and usage limits apply.</p></div>
 <p className="text-xs text-zinc-400">Sign in on OpenAI’s website. Boardly saves the connection privately for your account so AI can keep helping with your projects. You can disconnect here at any time. This connects AI access; it does not import your ChatGPT conversations.</p>
 {ownerSubscription&&!state?.active&&<p className="text-sm text-emerald-300">Your account can use its existing cloud Codex worker. Connecting here lets you choose this ChatGPT connection for your AI work.</p>}
 {error&&<p role="alert" className="text-sm text-rose-300">{error}<button className="underline ml-2" onClick={()=>refresh().then(()=>setError('')).catch(e=>setError(e.message))}>Retry connection status</button></p>}
 {!state&&!error&&<p role="status" className="text-sm text-zinc-400">Checking ChatGPT connection…</p>}
 {state?.error&&<p role="alert" className="text-sm text-amber-200">{state.error}</p>}
 {state&&!state.configured&&<p className="text-sm text-amber-200">ChatGPT connections are temporarily unavailable. Please try again shortly.</p>}
 {state?.connected?<><p role="status" className="text-sm text-emerald-300">ChatGPT connected{state.email?' · '+state.email:''}{state.plan?' · '+state.plan:''}{state.active?' · Selected for your AI work':''}</p>
 <div className="flex flex-wrap gap-2">{!state.active&&<button disabled={busy} className={button+' bg-indigo-600'} onClick={()=>act('activate')}>Use ChatGPT for my AI work</button>}<button disabled={busy} className={button} onClick={()=>act('test')}>{busy?'Please wait…':'Test ChatGPT connection'}</button><button disabled={busy} className={button} onClick={()=>act('disconnect')}>Disconnect ChatGPT</button></div>
 {state.verified_at&&<p className="text-xs text-zinc-400">AI reply verified {new Date(state.verified_at).toLocaleString()}.</p>}{reply&&<p role="status" className="text-sm text-emerald-200">{reply}</p>}
 </>:state?.pending?<div className="space-y-3">
 <ol className="list-decimal pl-5 space-y-2 text-sm"><li>Open the OpenAI sign-in page and sign in with your ChatGPT account.</li><li>Enter this one-time code and approve the connection.</li><li>Return here. Boardly will detect your sign-in automatically.</li></ol>
 <div className="flex flex-wrap items-center gap-3"><code aria-label="OpenAI sign-in code" className="select-all rounded-lg bg-zinc-950 px-4 py-3 text-xl tracking-wider">{state.pending.user_code}</code><button className={button} onClick={()=>navigator.clipboard.writeText(state.pending.user_code).catch(()=>setError('Select the code and copy it manually.'))}>Copy code</button><a href={state.pending.verification_url} target="_blank" rel="noopener noreferrer" className={button+' bg-indigo-600'}>Open OpenAI sign-in</a></div>
 <p role="status" className="text-xs text-zinc-400">Waiting for approval · code expires {new Date(state.pending.expires_at).toLocaleTimeString()}.</p><button disabled={busy} className={button} onClick={()=>act('cancel')}>Cancel sign-in</button>
 </div>:state?.configured&&<button disabled={busy} className={button+' bg-indigo-600'} onClick={()=>act('login')}>{busy?'Getting your sign-in code…':'Connect ChatGPT'}</button>}
 <details className="text-sm"><summary className="cursor-pointer text-zinc-300">Trouble signing in?</summary><p className="mt-2 text-zinc-400">In ChatGPT, open Settings → Security and enable device-code login. For a managed workspace, your workspace administrator may need to allow it. Then start a new code. If your plan has reached its Codex limit, wait for the reset or check your plan in ChatGPT.</p><a className="inline-block mt-2 text-indigo-300 underline" href="https://learn.chatgpt.com/docs/auth#login-on-headless-devices" target="_blank" rel="noopener noreferrer">OpenAI’s sign-in instructions</a></details>
 </section>;
}
