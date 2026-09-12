import React,{useEffect,useState} from 'react';
import {Building2,KanbanSquare,FolderOpen,Plus,ArrowLeft,Mail,Settings2,Plug} from 'lucide-react';
import {api} from '../api.js';
import {useAccess} from '../access.jsx';
import ScopeSettings from './ScopeSettings.jsx';
import AgentHub from './AgentHub.jsx';
import AudioBriefing from './AudioBriefing.jsx';
import AiActions from './AiActions.jsx';
import ComputerUseAssignment from './ComputerUseAssignment.jsx';
import AccountComputerUse from './AccountComputerUse.jsx';
import CompaniesOverview from './CompaniesOverview.jsx';
import CompanyActivity from './CompanyActivity.jsx';
import CompanyOnboarding,{CompanyStart,QuickCompany,startCompanyPlan} from './CompanyOnboarding.jsx';
import CompanyChat from './CompanyChat.jsx';
import MasterChat from './MasterChat.jsx';
const button='rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50';
const input='rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm';
const navigate=path=>{location.hash=path;};
function route(){const m=location.hash.match(/^#\/(company|collection|company-add|company-build|master)\/([\w-]+)/);return m?{kind:m[1],id:m[2],settings:location.hash.includes('/settings')?(location.hash.match(/\/settings(?:\/([^/?]+))?/)?.[1]||'general'):null}:{kind:'home'};}
export default function CompanyWorkspace({onOpen,cloud=true}){
 const [showAI,setShowAI]=useState(false);
 const [showAudio,setShowAudio]=useState(false);
 const access=useAccess(),owner=access.workspaceOwner!==false;
 const [data,setData]=useState(null),[view,setView]=useState(route),[requestedTab,setTab]=useState('boards'),[error,setError]=useState(''),[form,setForm]=useState(null),[busy,setBusy]=useState(false);
 const load=()=>api.get('/api/hierarchy').then(setData);
 useEffect(()=>{
  let active=true,pending=false;
  const refresh=async()=>{if(!active||pending)return;pending=true;try{const next=await api.get('/api/hierarchy');if(active){setData(next);setError('');}}catch(e){if(active)setError(e.message);}finally{pending=false;}};
  const visible=()=>{if(document.visibilityState==='visible')refresh();};
  const changed=()=>{setView(route());setShowAI(false);setShowAudio(false);setForm(null);setTab('boards');setError('');refresh();};
  refresh();const timer=setInterval(visible,3000);
  window.addEventListener('hashchange',changed);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('hashchange',changed);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
 },[]);
 async function act(fn){setBusy(true);setError('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}}
 if(!data)return <main data-membership-ui className="max-w-6xl mx-auto p-6">{error||'Loading companies…'}</main>;
 const shared=(access.workspaces||[]).filter(w=>!w.owner&&w.owner_id!==access.workspaceId).flatMap(w=>(w.companies||[]).map(c=>({...c,workspaceId:w.owner_id})));
 const company=data.companies.find(c=>c.id===Number(view.id)),board=data.boards.find(b=>b.id===Number(view.id));
 const canCompany=scope=>owner||company?.scopes?.includes(scope);
 const canChat=owner||['editor','viewer'].includes(company?.role);
 const tab=requestedTab==='boards'||(requestedTab==='chat'?canChat:requestedTab==='emails'?owner:canCompany(requestedTab))?requestedTab:'boards';
 const companyId=view.kind==='company'?company?.id??null:board?.company_id??null;
 const heading=view.kind==='home'?'Companies':view.kind==='company'?company?.name||'Unassigned boards':board?.name||'Board not found';
 const boards=data.boards.filter(b=>b.company_id===companyId),projects=data.projects.filter(p=>p.parent_board_id===board?.id);
 const canOpenAI=owner&&cloud&&((view.kind==='company'&&company)||(view.kind==='collection'&&board));
 const scopedProjects=view.kind==='collection'?projects:view.kind==='company'?data.projects.filter(p=>boards.some(b=>b.id===p.parent_board_id)):data.projects;
 const audioProject=scopedProjects.find(p=>owner||p.role==='editor');
 const audioCompany=owner?(view.kind==='home'?data.companies[0]:view.kind==='company'?company:null):null;
 const audioTarget=owner&&view.kind==='collection'&&board?{kind:'board',id:board.id}:audioCompany?{kind:'company',id:audioCompany.id}:audioProject?{kind:'project',id:audioProject.id}:null;
 function newForm(kind){setForm({kind,name:'',id:null});}
 async function save(e){e.preventDefault();await act(async()=>{
   const paths={company:'/api/companies',board:'/api/company-boards',project:'/api/projects'};const body={name:form.name};
   if(form.kind==='board')body.company_id=companyId;if(form.kind==='project')body.parent_board_id=board.id;
   if(form.id)await api.patch(`${paths[form.kind]}/${form.id}`,body);else{const result=await api.post(paths[form.kind],body);if(form.kind==='company')navigate(`#/company/${result.id}`);if(form.kind==='project')onOpen(result.id);}
   setForm(null);
 });}
 if(cloud&&owner&&view.kind==='master')return <MasterChat/>;
 if(cloud&&owner&&view.kind==='company-build')return <CompanyOnboarding key={view.id} id={view.id}/>;
 if(cloud&&owner&&view.kind==='company-add')return view.id==='quick'?<QuickCompany/>:<main className="max-w-4xl mx-auto p-6 space-y-6"><button className={button} onClick={()=>navigate('#/')}>Back to companies</button><CompanyStart/></main>;
 if(view.kind==='company'&&company&&view.settings)return <ScopeSettings kind="company" entity={company} section={view.settings} owner={owner} can={canCompany} onSaved={load} onBack={()=>navigate(`#/company/${company.id}`)}/>;
 return <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
  <style>{`[data-membership-ui] [hidden]{display:none!important}`}</style>
  <nav className="flex flex-wrap gap-2 text-sm text-zinc-400"><button onClick={()=>navigate('#/')}>Companies</button>{view.kind==='company'&&<><span>/</span><span className="text-zinc-200">{heading}</span></>}{view.kind==='collection'&&board&&<><span>/</span><button onClick={()=>navigate(`#/company/${board.company_id??'unassigned'}`)}>{data.companies.find(c=>c.id===board.company_id)?.name||'Unassigned'}</button><span>/</span><span className="text-zinc-200">{board.name}</span></>}</nav>
  <div className="flex flex-wrap justify-between gap-4 items-start"><div><h1 className="text-2xl font-bold">{heading}</h1><p className="text-sm text-zinc-400 mt-2">{view.kind==='home'?'Companies contain boards. Boards organize projects and their tasks.':view.kind==='company'?'Boards, projects and shared company email.':'Each project has its own tasks, AI chat, files and settings.'}</p></div>
   <div className="flex flex-wrap gap-2">{view.kind==='company'&&company&&<button aria-label="Company settings" className={button} onClick={()=>navigate(`#/company/${company.id}/settings/general`)}><Settings2 size={16} className="inline mr-2"/>Settings</button>}<div className="flex gap-2" hidden={!owner}>{view.kind==='home'?<button className={button+' bg-indigo-600'} onClick={()=>cloud?navigate('#/company-add/choose'):newForm('company')}>Add company</button>:view.kind==='company'?<><button className={button} onClick={()=>newForm('board')}>New board</button></>:board&&<><button className={button+' bg-indigo-600'} onClick={()=>newForm('project')}>New project</button><button className={button} onClick={()=>setForm({kind:'board',id:board.id,name:board.name})}>Rename board</button></>}</div></div>
  </div>
  {cloud&&owner&&<div className="flex flex-wrap gap-2"><button className={button+' border-indigo-400 text-indigo-200'} onClick={()=>navigate('#/master/chat')}>Master Chat · all companies</button>{view.kind==='company'&&company&&<><button className={button} onClick={()=>navigate(`#/company/${company.id}/settings/skills`)}>Rules & Skills</button><button className={button} onClick={()=>navigate(`#/company/${company.id}/settings/storage`)}>Company storage</button></>}</div>}
  {view.kind==='home'&&cloud&&owner&&<CompanyStart choices={!data.companies.length}/>}
  {view.kind==='company'&&company&&cloud&&owner&&<button className={button} disabled={busy} onClick={()=>act(()=>startCompanyPlan(company.id))}>Plan my next steps</button>}
  {canOpenAI?<AiActions chatLabel="Chat with AI / Agent swarm" onChat={()=>setShowAI(true)} onAudio={()=>setShowAudio(audioTarget)}/>:cloud&&audioTarget&&<button className={button+' border-indigo-400 text-indigo-100'} onClick={()=>setShowAudio(audioTarget)}>Audio briefing</button>}
  {showAudio&&<AudioBriefing key={showAudio.kind+showAudio.id} kind={showAudio.kind} id={showAudio.id} onClose={()=>setShowAudio(false)}/>}
  {showAI&&<AgentHub key={view.kind+view.id} kind={view.kind==='company'?'company':'board'} id={Number(view.id)} onClose={()=>setShowAI(false)} onOpen={onOpen}/>}
  {error&&<p role="alert" className="text-sm text-rose-300">{error}</p>}
  {form&&<form onSubmit={save} className="p-4 rounded-xl border border-indigo-500/40 bg-zinc-900 flex flex-wrap gap-3"><label className="flex-1 min-w-48"><span className="sr-only">{form.kind} name</span><input className={input+' w-full'} placeholder={`${form.kind[0].toUpperCase()+form.kind.slice(1)} name`} maxLength={200} autoFocus required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><button disabled={busy} className={button+' bg-indigo-600'}>{form.id?'Save name':`Create ${form.kind}`}</button><button type="button" className={button} onClick={()=>setForm(null)}>Cancel</button></form>}
  {view.kind==='home'&&cloud&&owner&&<AccountComputerUse home companies={data.companies} onCompany={id=>navigate(`#/company/${id}`)}/>}
  {view.kind==='company'&&company&&cloud&&canCompany('computers')&&<ComputerUseAssignment key={company.id} kind="companies" id={company.id}/>}
  {view.kind==='home'&&<>{shared.length>0&&<section aria-label="Shared companies" className="space-y-3"><h2 className="text-lg font-semibold">Shared with you</h2><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{shared.map(c=><button key={c.workspaceId+':'+c.id} onClick={()=>access.onSwitch?.(c.workspaceId,`#/company/${c.id}`)} className="text-left rounded-2xl border border-indigo-500/40 bg-zinc-900 hover:border-indigo-400 p-6"><Building2 className="text-indigo-400 mb-4"/><h3 className="font-semibold text-lg">{c.name}</h3><p className="text-xs text-zinc-400 mt-2">{c.board_count} boards · {c.project_count} projects · {c.role==='project_guest'?'Shared projects':c.role==='editor'?'Editor':'Viewer'}</p></button>)}</div></section>}{cloud&&owner&&<CompaniesOverview onOpen={onOpen} onCompany={id=>navigate(`#/company/${id??'unassigned'}`)}/>}<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{data.companies.map(c=><button key={c.id} onClick={()=>navigate(`#/company/${c.id}`)} className="text-left rounded-2xl border border-zinc-800 bg-zinc-900 hover:border-indigo-500/50 p-6"><Building2 className="text-indigo-400 mb-4"/><h2 className="font-semibold text-lg">{c.name}</h2><p className="text-xs text-zinc-500 mt-2">{data.boards.filter(b=>b.company_id===c.id).length} boards · {data.projects.filter(p=>data.boards.some(b=>b.id===p.parent_board_id&&b.company_id===c.id)).length} projects</p></button>)}{!cloud&&!data.companies.length&&!shared.length&&<div className="sm:col-span-2 rounded-xl border border-dashed border-zinc-700 p-6 text-sm text-zinc-400">Create your first company, then move boards into it. Your existing work is available in Unassigned boards.</div>}</div>
   <button onClick={()=>navigate('#/company/unassigned')} className="w-full text-left rounded-xl border border-zinc-800 p-5 flex items-center gap-3"><KanbanSquare className="text-zinc-500"/><div><p className="font-medium">Unassigned boards</p><p className="text-sm text-zinc-500">{data.boards.filter(b=>b.company_id==null).length} boards · choose a company when ready</p></div></button></>}
  {view.kind==='company'&&<><div className="flex flex-wrap gap-4 border-b border-zinc-800"><button className={`pb-3 text-sm ${tab==='boards'?'border-b-2 border-indigo-400 text-indigo-300':'text-zinc-400'}`} onClick={()=>setTab('boards')}>Boards</button>{company&&cloud&&canChat&&<button className={`pb-3 text-sm ${tab==='chat'?'border-b-2 border-indigo-400 text-indigo-300':'text-zinc-400'}`} onClick={()=>setTab('chat')}>Team chat</button>}{company&&cloud&&owner&&<button className={`pb-3 text-sm flex gap-2 items-center ${tab==='emails'?'border-b-2 border-indigo-400 text-indigo-300':'text-zinc-400'}`} onClick={()=>navigate(`#/company/${company.id}/settings/emails`)}><Mail size={16}/>Emails</button>}{company&&cloud&&<button className="pb-3 text-sm text-zinc-400 flex gap-2 items-center" onClick={()=>navigate(`#/company/${company.id}/settings/connectors`)}><Plug size={16}/>Connectors</button>}</div>
   {tab==='chat'?<CompanyChat key={company.id} companyId={company.id}/>:<><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{boards.map(b=><article key={b.id} className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden"><button className="p-5 w-full text-left hover:bg-zinc-800/40" onClick={()=>navigate(`#/collection/${b.id}`)}><KanbanSquare className="text-indigo-400 mb-3"/><h2 className="font-semibold">{b.name}</h2><p className="text-xs text-zinc-500 mt-2">{data.projects.filter(p=>p.parent_board_id===b.id).length} projects</p></button><details hidden={!owner} className="px-5 pb-4 text-sm"><summary className="text-zinc-400 cursor-pointer">Move board</summary><label className="text-xs text-zinc-500">Company<select aria-label={`Company for ${b.name}`} disabled={busy} className={input+' w-full mt-1'} value={b.company_id??''} onChange={e=>act(()=>api.patch(`/api/company-boards/${b.id}`,{company_id:e.target.value?Number(e.target.value):null}))}><option value="">Unassigned</option>{data.companies.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label></details></article>)}</div>{!boards.length&&<p className="text-sm text-zinc-400">No boards here yet. Create a board or move one here from Unassigned boards.</p>}
   {company&&cloud&&owner&&<CompanyActivity key={company.id} companyId={company.id} onOpen={onOpen} onChat={()=>setShowAI(true)} onAudio={()=>setShowAudio({kind:'company',id:company.id})}/>}
</>}
  </>}
  {view.kind==='collection'&&board&&<><div hidden={!owner} className="flex flex-wrap items-end gap-3"><label className="text-sm text-zinc-400">Company<select aria-label="Board company" className={input+' block mt-1'} disabled={busy} value={board.company_id??''} onChange={e=>act(()=>api.patch(`/api/company-boards/${board.id}`,{company_id:e.target.value?Number(e.target.value):null}))}><option value="">Unassigned</option>{data.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><span className="text-xs text-zinc-500 pb-2">Moving this board moves all of its projects.</span></div>
   <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{projects.map(p=><article key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden"><div className="h-1" style={{background:p.color}}/><button className="w-full text-left p-5 hover:bg-zinc-800/40" onClick={()=>onOpen(p.id)}><span className="text-2xl">{p.emoji}</span><h2 className="font-semibold mt-3">{p.name}</h2><p className="text-xs text-zinc-500 mt-2">{p.task_count} tasks · Chat, files & settings</p></button><details hidden={!owner} className="px-5 pb-4 text-sm"><summary className="text-zinc-400 cursor-pointer">Organize project</summary><label className="text-xs text-zinc-500">Board<select aria-label={`Board for ${p.name}`} disabled={busy} className={input+' w-full mt-1'} value={p.parent_board_id} onChange={e=>act(()=>api.patch(`/api/projects/${p.id}`,{parent_board_id:Number(e.target.value)}))}>{data.boards.map(b=><option key={b.id} value={b.id}>{data.companies.find(c=>c.id===b.company_id)?.name||'Unassigned'} / {b.name}</option>)}</select></label><div className="flex gap-3 mt-3 text-xs text-zinc-400"><button onClick={()=>setForm({kind:'project',id:p.id,name:p.name})}>Rename</button><button onClick={()=>act(async()=>{if(confirm(`Delete project ${p.name} and all its tasks, chats, files and settings? This cannot be undone.`))await api.del(`/api/boards/${p.id}`);})}>Delete project</button></div></details></article>)}</div>
   {!projects.length&&<p className="text-sm text-zinc-400">Create a project to start adding tasks and chatting with AI.</p>}{!projects.length&&owner&&<button className="text-xs text-zinc-500" onClick={()=>act(async()=>{if(!confirm(`Delete empty board ${board.name}?`))return;await api.del(`/api/company-boards/${board.id}`);navigate(`#/company/${board.company_id??'unassigned'}`);})}>Delete empty board</button>}
  </>}
 </main>;
}
