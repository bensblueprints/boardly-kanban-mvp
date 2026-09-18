import React,{useEffect,useState} from 'react';
import {api} from '../api.js';
import {settingsButton,settingsInput,accountSettings} from './SettingsShell.jsx';
function LoginPicker({onChoose}){
 const [vaults,setVaults]=useState(null),[vault,setVault]=useState(''),[items,setItems]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;setItems(null);setError('');if(vault)api.get(`/api/account/onepassword/vaults/${vault}/items`).then(d=>{if(active)setItems(d.items);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[vault]);
 return <div className="space-y-3 border-b border-zinc-700 pb-4">{!vaults?<button type="button" className={settingsButton} disabled={busy} onClick={async()=>{setBusy(true);setError('');try{setVaults((await api.get('/api/account/onepassword/vaults')).vaults);}catch(e){setError(e.message);}finally{setBusy(false);}}}>Choose a login from 1Password</button>:<><label className="block text-sm">Vault<select aria-label="1Password vault" className={settingsInput+' mt-2'} value={vault} onChange={e=>setVault(e.target.value)}><option value="">Choose a vault</option>{vaults.map(v=><option value={v.id} key={v.id}>{v.title}</option>)}</select></label>{vault&&!items&&!error&&<p className="text-sm text-zinc-400">Loading login names…</p>}{items&&<label className="block text-sm">Vault login<select aria-label="1Password vault login" className={settingsInput+' mt-2'} defaultValue="" onChange={e=>{const item=items.find(i=>i.id===e.target.value);if(item)onChoose({label:item.title,url:item.origins[0]||'',username_ref:item.username?`op://${vault}/${item.id}/username`:'',password_ref:`op://${vault}/${item.id}/password`});}}><option value="">Choose a login</option>{items.map(i=><option value={i.id} key={i.id}>{i.title}</option>)}</select></label>}{items?.length===0&&<p className="text-sm text-zinc-400">No Login or Password items in this vault.</p>}</>}{error&&<p role="alert" className="text-rose-300">{error}</p>}</div>;
}
export default function OnePasswordConnection({kind='account',id}){
 const account=kind==='account',base=account?'/api/account/onepassword':`/api/${kind==='company'?'companies':'projects'}/${id}/onepassword`;
 const [selected,setSelected]=useState([]),[state,setState]=useState(null),[token,setToken]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[draft,setDraft]=useState({label:'',url:'',username_ref:'',password_ref:''});
 useEffect(()=>{let active=true;setState(null);api.get(base).then(d=>{if(active){setState(d);setSelected(d.login_ids||[]);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base]);
 async function act(fn,message){setBusy(true);setError('');setNotice('');try{setState(await fn());setNotice(message);}catch(e){setError(e.message);}finally{setToken('');setBusy(false);}}
 return <div className="space-y-5">{error&&<p role="alert" className="text-rose-300">{error}</p>}{notice&&<p role="status" className="text-emerald-300">{notice}</p>}
 <p className="text-sm text-zinc-400">Let agents fill approved account logins on assigned ComputerUse desktops. Credentials are resolved when needed and are not returned in agent tool results. MFA and CAPTCHA can be completed through Take control.</p>
 {!state&&!error&&<p>Loading connection…</p>}
 {state&&account&&<>
 <form className="space-y-3 border border-zinc-700 rounded-xl p-4" onSubmit={e=>{e.preventDefault();act(()=>api.put(base,{token}),'1Password connected. Add approved logins below.');}}>
 <h3 className="font-semibold">{state.saved?'1Password connected':'Connect your automation vault'}</h3>
 <p className="text-sm text-zinc-400">Create a separate vault for agent logins. Give a <a className="text-indigo-300 underline" target="_blank" rel="noreferrer" href="https://developer.1password.com/docs/service-accounts/get-started/">1Password service account</a> read access to that vault, then paste its token here. Your master password is not needed.</p>
 <label className="block text-sm">Service account token<input aria-label="1Password service account token" required type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} placeholder={state.saved?'Paste a replacement token':'ops_…'} className={settingsInput+' mt-2'}/></label>
 <button className={settingsButton+' bg-indigo-600'} disabled={busy||!token}>{state.saved?'Replace connection':'Connect 1Password'}</button>
 {state.saved&&<button type="button" className={settingsButton+' ml-2'} disabled={busy} onClick={()=>act(()=>api.delete(base),'Disconnected. Agent login access is paused.')}>Disconnect</button>}
 </form>
 {state.saved&&<form className="space-y-3 border border-zinc-700 rounded-xl p-4" onSubmit={e=>{e.preventDefault();act(async()=>{const result=await api.post(base+'/logins',draft);setDraft({label:'',url:'',username_ref:'',password_ref:''});return result;},'Login added. Enable it in company or project settings.');}}>
 <h3 className="font-semibold">Add an approved login</h3>
 <LoginPicker onChoose={setDraft}/>
 <p className="text-sm text-zinc-400">Copy secret references from 1Password using vault and item IDs. Boardly saves these references, not a copy of the password. The website must match exactly, including its subdomain.</p>
 {[['label','Login name','text','Company Google account'],['url','Login URL','url','https://accounts.google.com/'],['username_ref','Username reference (optional)','text','op://vault-id/item-id/username'],['password_ref','Password reference','text','op://vault-id/item-id/password']].map(([key,label,type,placeholder])=><label key={key} className="block text-sm">{label}<input aria-label={label} type={type} required={key!=='username_ref'} value={draft[key]} onChange={e=>setDraft(d=>({...d,[key]:e.target.value}))} placeholder={placeholder} className={settingsInput+' mt-2'}/></label>)}
 <button className={settingsButton} disabled={busy}>Add login</button>
 </form>}
 <div className="space-y-3"><h3 className="font-semibold">Approved logins</h3>{state.logins.length?state.logins.map(l=><article key={l.id} className="border border-zinc-800 rounded-xl p-4 flex flex-wrap gap-3 justify-between"><div className="min-w-0"><h4 className="font-medium">{l.label}</h4><p className="text-sm text-zinc-400 break-all">{new URL(l.url).origin}</p></div><button disabled={busy} className={settingsButton} onClick={()=>act(()=>api.delete(base+'/logins/'+l.id),'Login removed from every company and project.')}>Remove login</button></article>):<p className="text-sm text-zinc-400">No approved logins yet.</p>}</div>
 <p className="text-sm text-zinc-400">Next: Company settings → 1Password → choose the logins that company may use. Projects inherit those logins and may add project-only access.</p>
 {!!state.audit?.length&&<details><summary className="cursor-pointer text-sm">Recent login activity</summary><ul className="mt-3 space-y-2">{state.audit.map((a,i)=><li key={i} className="text-sm text-zinc-400">{new Date(a.created_at).toLocaleString()} · {state.logins.find(l=>l.id===a.login_id)?.label||'Removed login'} · {a.operation} · {a.state}</li>)}</ul></details>}
 </>}
 {state&&!account&&<>
 <p className="text-sm text-zinc-400">Selected logins are available to agents with Computer use permission on an assigned desktop. Grant access only to trusted users and desktops: a logged-in session can act on the account.</p>
 {!state.saved&&<button className={settingsButton} onClick={()=>accountSettings('onepassword')}>Connect 1Password in account settings</button>}
 {state.logins.map(l=>{const inherited=state.inherited_ids.includes(l.id),checked=inherited||selected.includes(l.id);return <label key={l.id} className="flex items-start gap-3 border border-zinc-700 rounded-xl p-4"><input type="checkbox" className="mt-1" disabled={busy||!state.saved||inherited} checked={checked} onChange={e=>{setSelected(ids=>e.target.checked?[...ids,l.id]:ids.filter(x=>x!==l.id));}}/><span><span className="font-medium">{l.label}</span><span className="block text-sm text-zinc-400 break-all">{new URL(l.url).origin}{inherited?' · inherited from company':''}</span></span></label>;})}
 {!!state.logins.length&&<button className={settingsButton+' bg-indigo-600'} disabled={busy||!state.saved} onClick={()=>act(()=>api.put(base,{login_ids:selected}),'Login access updated.')}>Save login access</button>}
 {!state.logins.length&&<p className="text-sm text-zinc-400">Add approved logins in account settings first.</p>}
 <button className={settingsButton} onClick={()=>accountSettings('onepassword')}>Manage account logins</button>
 </>}
 </div>;
}
