import React,{useEffect,useState} from 'react';
import {Network,RefreshCw} from 'lucide-react';
import {api} from '../api.js';
import {COMPANY_COLORS,workStatus,agentState} from '../company-status.mjs';
const titles={idle:'Idle',blocked:'Blocked',working:'Working',done:'All done'};
export default function CompaniesOverview({onOpen,onCompany}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[filter,setFilter]=useState('all'),[clock,setClock]=useState(Date.now()),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true,busy=false;const load=async()=>{if(busy)return;busy=true;try{const value=await api.get('/api/agents/companies/dashboard');if(active){setData({...value,received_at:Date.now()});setError('');}}catch(e){if(active)setError(e.message);}finally{busy=false;}};load();const polling=setInterval(load,2500),timer=setInterval(()=>setClock(Date.now()),1000);return()=>{active=false;clearInterval(polling);clearInterval(timer);};},[retry]);
 const now=data?data.updated_at+Math.max(0,clock-data.received_at):clock;
 const all=(data?.companies||[]).map(company=>{const projects=data.projects.filter(p=>p.company_id===company.id),agents=data.agents.filter(a=>a.company_id===company.id);return{...company,projects,agents,status:workStatus(projects,agents,now,data.freshness_ms)};});
 let cursor=58;
 const rows=all.filter(c=>filter==='all'||c.status.state===filter).map(company=>{
  const groups=company.projects.map(project=>({...project,agents:company.agents.filter(a=>a.project_id===project.id),status:workStatus([project],company.agents.filter(a=>a.project_id===project.id),now,data.freshness_ms)}));
  for(const agent of company.agents.filter(a=>!a.project_id)){let group=groups.find(g=>g.discussion===agent.kind&&g.board_id===agent.board_id);if(!group){group={id:'discussion-'+agent.kind+'-'+agent.board_id,name:agent.kind==='company'?'Company conversations':(data.boards.find(b=>b.id===agent.board_id)?.name||'Board')+' · conversations',discussion:agent.kind,board_id:agent.board_id,agents:[]};groups.push(group);}group.agents.push(agent);}
  const start=cursor;let y=cursor;
  for(const group of groups){group.height=Math.max(72,group.agents.length*62+10);group.y=y+group.height/2;y+=group.height;group.status??=workStatus([],group.agents,now,data.freshness_ms);}
  const height=Math.max(95,y-start);cursor+=height+38;return{...company,groups,y:start+height/2,height,start};
 });
 const height=Math.max(210,cursor+15);
 const activate=(event,action)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();action();}};
 const companyClick=company=>onCompany(company.id);
 const node=(x,y,width,title,subtitle,color,action,label,key,state)=> <g key={key} role="button" tabIndex="0" aria-label={label} data-state={state} onClick={action} onKeyDown={event=>activate(event,action)} className="cursor-pointer outline-none focus:[&>rect]:stroke-white"><title>{title+' — '+subtitle}</title><rect x={x} y={y-27} width={width} height="54" rx="10" fill="#18181f" stroke={color} strokeOpacity=".6"/><circle cx={x+15} cy={y} r="4" fill={color}/><text x={x+28} y={y-5} fill="#e4e4e7" fontSize="13">{title.length>27?title.slice(0,26)+'…':title}</text><text x={x+28} y={y+14} fill="#a1a1aa" fontSize="11">{subtitle.length>35?subtitle.slice(0,34)+'…':subtitle}</text></g>;
 return <section aria-label="All companies agent graph" className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4 sm:p-6 space-y-5">
  <style>{`@keyframes overview-flow{to{stroke-dashoffset:-36}}.overview-flow{stroke-dasharray:6 12;animation:overview-flow 1.4s linear infinite}@media(prefers-reduced-motion:reduce){.overview-flow{animation:none}}`}</style>
  <header className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold text-lg flex items-center gap-2"><Network size={20} className="text-indigo-300"/>Your companies, live</h2><p className="text-sm text-zinc-400 mt-1">See every project agent and which companies need attention.</p></div><button aria-label="Refresh company graph" className="p-2 rounded-lg border border-zinc-700 hover:bg-zinc-800" onClick={()=>setRetry(n=>n+1)}><RefreshCw size={16}/></button></header>
  <div className="flex flex-wrap gap-2" aria-label="Filter companies by status"><button onClick={()=>setFilter('all')} aria-pressed={filter==='all'} className={'rounded-lg border px-3 py-2 text-sm '+(filter==='all'?'border-indigo-400 bg-indigo-500/10':'border-zinc-800 text-zinc-400')}>All companies {all.length}</button>{Object.entries(titles).map(([state,title])=><button key={state} onClick={()=>setFilter(state)} aria-pressed={filter===state} className={'flex gap-2 items-center rounded-lg border px-3 py-2 text-sm '+(filter===state?'border-zinc-500 bg-zinc-800':'border-zinc-800 text-zinc-400')}><span style={{background:COMPANY_COLORS[state]}} className="w-2 h-2 rounded-full"/>{title} {all.filter(c=>c.status.state===state).length}</button>)}</div>
  {error&&<p role="alert" className="text-sm text-amber-300">Live update paused: {error}. Working indicators expire when agent contact becomes stale.</p>}
  {!data&&!error&&<p className="text-sm text-zinc-400 py-5">Loading companies and agents…</p>}
  {data&&rows.length>0&&<div className="overflow-auto max-h-[640px] rounded-xl border border-zinc-800 bg-zinc-950" tabIndex="0" aria-label="Scrollable company, project and agent graph"><svg viewBox={`0 0 1030 ${height}`} className="w-full min-w-[950px]" role="img" aria-label="All companies connected to projects and individual agents">
   <text x="28" y="29" fill="#71717a" fontSize="11" letterSpacing="2">COMPANIES</text><text x="359" y="29" fill="#71717a" fontSize="11" letterSpacing="2">PROJECTS</text><text x="699" y="29" fill="#71717a" fontSize="11" letterSpacing="2">AGENTS</text>
   {rows.map(company=><g key={company.id??'unassigned'}>
    {company.groups.map(group=><g key={group.id}>
     <path d={`M285 ${company.y} C315 ${company.y} 320 ${group.y} 350 ${group.y}`} stroke={group.status.color} strokeOpacity=".35" fill="none"/>
     {group.status.working>0&&<path className="overview-flow" d={`M285 ${company.y} C315 ${company.y} 320 ${group.y} 350 ${group.y}`} stroke={COMPANY_COLORS.working} fill="none"/>}
     {node(350,group.y,275,group.name,group.discussion?group.agents.length+' conversations':group.board_name+' · '+group.status.label,group.status.color,()=>group.discussion?companyClick(company):onOpen(group.id),'Open '+group.name,group.id,group.status.state)}
     {group.agents.map((agent,index)=>{const y=group.y+(index-(group.agents.length-1)/2)*62,status=agentState(agent,now,data.freshness_ms);return <g key={agent.id}><path d={`M625 ${group.y} C655 ${group.y} 660 ${y} 690 ${y}`} fill="none" stroke={status.color} strokeOpacity=".4"/>{status.state==='working'&&<path className="overview-flow" d={`M625 ${group.y} C655 ${group.y} 660 ${y} 690 ${y}`} fill="none" stroke={status.color}/>} {node(690,y,312,agent.title||'Project agent',(agent.mode||'work').toUpperCase()+' · '+status.label,status.color,()=>agent.project_id?onOpen(agent.project_id):companyClick(company),'Inspect agent '+agent.title,agent.id,status.state)}</g>;})}
    </g>)}
    {node(20,company.y,265,company.name,company.status.label,company.status.color,()=>companyClick(company),'Open company '+company.name,company.id??'none',company.status.state)}
   </g>)}
  </svg></div>}
  {data&&!rows.length&&<p className="py-6 text-sm text-zinc-400">{all.length?'No companies have this status.':'Create a company to see it and its project agents here.'}</p>}
  <p className="text-xs text-zinc-500">Gray: nothing running · Red: a blocker · Yellow: recent agent activity · Green: all tasks done. Queued work stays gray. A blocker takes priority even when other agents are working. Select a company or agent to open its work.</p>
 </section>;
}
