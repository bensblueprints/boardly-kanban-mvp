import React,{useEffect,useMemo,useState} from 'react';
import {api} from '../api.js';
const input='mt-1 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm';
export default function GithubRepositoryPicker({base,source,token,revision,enabled,onSelect}){
 const [repositories,setRepositories]=useState([]),[query,setQuery]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;setRepositories([]);setError('');setLoading(enabled);
  if(!enabled)return;
  const timer=setTimeout(async()=>{let page=1,version;const collected=new Map();
   try{while(active&&page){const result=await api.post(base+'/repositories',{credential_source:source,...(token?{token}:{}),page,...(version?{credential_version:version}:{})});if(!active)return;
    for(const repo of result.repositories)collected.set(repo.repository.toLowerCase(),repo);
    setRepositories([...collected.values()]);version=result.credential_version;page=result.next_page;
   }}catch(e){if(active){setRepositories([]);setError(e.message);}}finally{if(active)setLoading(false);}
  },token?400:0);
  return()=>{active=false;clearTimeout(timer);};
 },[base,source,token,revision,enabled,refresh]);
 const filtered=useMemo(()=>{const words=query.trim().toLowerCase().split(/\s+/);return repositories.filter(r=>words.every(w=>r.repository.toLowerCase().includes(w)));},[repositories,query]);
 return <div className="rounded-lg border border-zinc-700 p-3 space-y-3" aria-label="GitHub repository picker">
  <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">Choose from GitHub</span><button type="button" disabled={!enabled||loading} className="text-xs text-indigo-300 underline disabled:opacity-40" onClick={()=>setRefresh(n=>n+1)}>Refresh repositories</button></div>
  <label className="block text-sm text-zinc-300">Search repositories<input type="search" autoComplete="off" disabled={!enabled} className={input} placeholder="Type a repository or organization name" value={query} onChange={e=>setQuery(e.target.value)}/></label>
  <label className="block text-sm text-zinc-300">Repository dropdown<select aria-label="Choose GitHub repository" disabled={!enabled||filtered.length===0} className={input} value="" onChange={e=>{const repo=repositories.find(r=>r.repository===e.target.value);if(repo)onSelect(repo);}}><option value="">Select a repository…</option>{filtered.map(r=><option key={r.repository} value={r.repository}>{r.repository}{r.private?' · Private':''}{r.archived?' · Archived':''}</option>)}</select></label>
  <p role="status" className="text-xs text-zinc-400">{!enabled?'Add a PAT above to browse, or enter a repository URL below.':loading?`Loading repositories… ${repositories.length} found.`:error?'You can still enter a repository URL below.':repositories.length===0?'No repositories are available to this PAT. Check its repository access, then refresh.':filtered.length===0?'No matching repositories. Try another name or enter a URL below.':`${filtered.length} ${filtered.length===1?'repository':'repositories'}${query?' matching your search':''}. Selecting one fills the URL and default branch below.`}</p>
  {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}
 </div>;
}
