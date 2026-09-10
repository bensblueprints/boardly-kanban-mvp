import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export default function AccountGithub({focus=false}){
 const [state,setState]=useState(null),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const field=useRef(null),base='/api/account/github';
 useEffect(()=>{let active=true;api.get(base).then(v=>{if(active)setState(v);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 useEffect(()=>{if(focus&&state){field.current?.scrollIntoView({block:'center'});field.current?.focus({preventScroll:true});}},[focus,!!state]);
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();setState(await api.get(base));}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section aria-label="Account GitHub" className="border-t border-zinc-700 pt-5 space-y-4">
  <h3 className="font-semibold">Account GitHub PAT</h3>
  <p className="text-sm text-zinc-400">Save your personal access token once, then assign repositories in company or project GitHub settings. A project repository overrides its company repository. The token is encrypted and never displayed in chats or to members.</p>
  {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-300">{notice}</p>}
  {state&&<><p className={'text-sm '+(state.has_token?'text-emerald-300':'text-amber-200')}>{state.has_token?`Account PAT saved${state.login?' · Verified as '+state.login:''}`:'Add your GitHub PAT to connect repositories across your companies.'}</p>
  <form className="space-y-3" onSubmit={e=>{e.preventDefault();act(async()=>{await api.put(base,{token});setToken('');setNotice('Account GitHub PAT saved. Company and project assignments will use it across chats.');});}}>
   <label className="block text-sm">Account GitHub personal access token<input ref={field} type="password" autoComplete="new-password" spellCheck={false} required minLength={20} maxLength={2000} value={token} onChange={e=>setToken(e.target.value)} placeholder={state.has_token?'Enter a new PAT to replace the saved one':'Paste your GitHub PAT here'} className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm"/></label>
   <p className="text-xs text-zinc-400">Give the PAT access to the repositories you assign, with Contents read/write for code changes. For repositories requiring a different GitHub account or token, choose a separate token in that company or project.</p>
   <button disabled={busy||!token} className={button}>{busy?'Saving…':'Save account GitHub PAT'}</button>
  </form>
  {state.has_token&&<div className="flex flex-wrap gap-3"><button disabled={busy} className={button} onClick={()=>act(async()=>{const result=await api.post(base+'/test',{});setNotice('GitHub account verified as '+result.login+'. Test each assigned repository to confirm its access.');})}>Test account PAT</button><button disabled={busy} className={button} onClick={()=>{if(window.confirm('Remove the account GitHub PAT? Repositories using it will stop connecting until you add a new PAT. Separate repository tokens are unaffected.'))act(async()=>{await api.del(base);setToken('');setNotice('Account PAT removed. Repository assignments are kept.');});}}>Remove account PAT</button></div>}</>}
 </section>;
}
