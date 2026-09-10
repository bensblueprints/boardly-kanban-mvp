import React,{useEffect,useState} from 'react';
import {api} from '../api.js';
const button='rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
export default function TailscaleConnection(){
 const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let mounted=true;const load=async()=>{try{const d=await api.get('/api/account/tailscale');if(mounted){setData(d);setError('');}}catch(e){if(mounted)setError(e.message);}};load();const timer=setInterval(load,3000);return()=>{mounted=false;clearInterval(timer);};},[]);
 async function act(action){setBusy(true);setError('');try{await api.post('/api/account/tailscale/'+action,{});setData(await api.get('/api/account/tailscale'));}catch(e){setError(e.message);}finally{setBusy(false);}}
 const connected=data?.state==='Running',started=data&&!['unavailable','disconnected'].includes(data.state);
 return <section aria-label="Tailscale connection" className="border-t border-zinc-700 pt-5 space-y-4"><div><h3 className="font-semibold">Tailscale · your devices</h3><p className="text-sm text-zinc-400 mt-2">Connect your private network to Boardly cloud. Choose which devices your company or project Work agents may use in SSH settings.</p></div>
 {error&&<p role="alert" className="text-sm text-amber-300">{error}</p>}
 {!data?<p className="text-sm text-zinc-500">Checking connection…</p>:!data.configured?<p className="text-sm text-amber-300">Cloud Tailscale connections are awaiting server setup.</p>:<>
 <p role="status" className={'text-sm '+(connected?'text-emerald-300':'text-zinc-400')}>{connected?'Connected to your Tailscale network':started?'Waiting for Tailscale sign-in or device approval':'Tailscale is not connected'}</p>
 {!started&&<button disabled={busy} className={button+' bg-indigo-600'} onClick={()=>act('connect')}>Connect Tailscale</button>}
 {data.auth_url&&<a className={button+' inline-block bg-indigo-600'} href={data.auth_url} target="_blank" rel="noopener noreferrer">Sign in to Tailscale</a>}
 {started&&<button disabled={busy} className={button} onClick={()=>act('disconnect')}>Disconnect Tailscale</button>}
 {started&&<p className="text-xs text-zinc-500">Boardly device: {data.device_name}. Your network remains separate from other Boardly accounts. Disconnecting immediately stops its device connections.</p>}
 {connected&&<div className="space-y-2">{data.devices.length===0&&<p className="text-sm text-zinc-500">No other devices are visible under your Tailscale permissions.</p>}{data.devices.map(d=><article key={d.id} className="rounded-xl border border-zinc-800 p-3 flex justify-between gap-3"><div><p className="text-sm">{d.name}</p><p className="text-xs text-zinc-500">{d.dns_name||d.addresses.join(', ')} · {d.os}</p></div><span className={'text-xs '+(d.online?'text-emerald-300':'text-zinc-500')}>{d.online?'Online':'Offline'}</span></article>)}</div>}
 </>}
 <p className="text-xs text-zinc-500">SSH credentials and permissions are still required. Ask and Plan cannot access devices or execute commands.</p>
 </section>;
}
