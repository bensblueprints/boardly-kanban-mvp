export const COMPANY_COLORS={idle:'#9ca3af',blocked:'#f87171',working:'#facc15',done:'#4ade80'};
export function agentWorking(agent,now,freshness=15000){return agent.status==='running'&&Number.isFinite(agent.updated_at)&&now-agent.updated_at>=-5000&&now-agent.updated_at<freshness;}
export function workStatus(projects,agents,now,freshness=15000){
 const total=projects.reduce((n,p)=>n+p.total_tasks,0),done=projects.reduce((n,p)=>n+p.done_tasks,0),blocked=projects.reduce((n,p)=>n+p.blocked_tasks,0);
 const working=agents.filter(a=>agentWorking(a,now,freshness)).length,waiting=agents.filter(a=>['queued','recovering'].includes(a.status)||(a.status==='running'&&!agentWorking(a,now,freshness))).length;
 const blockedAgents=agents.filter(a=>a.status==='blocked').length;
 const state=blocked||blockedAgents?'blocked':working?'working':total>0&&done===total&&!waiting?'done':'idle';
 const label=state==='blocked'?`${blocked} blocked task${blocked===1?'':'s'}${blockedAgents?` · ${blockedAgents} blocked agent${blockedAgents===1?'':'s'}`:''}`:state==='working'?`${working} agent${working===1?'':'s'} working`:state==='done'?'All tasks done':waiting?`${waiting} agent${waiting===1?'':'s'} queued / waiting`:total>done?`${total-done} tasks to do · no agent running`:'Nothing to do';
 return {state,label,total,done,blocked,blockedAgents,working,waiting,color:COMPANY_COLORS[state]};
}
export function agentState(agent,now,freshness=15000){
 if(agent.status==='blocked')return{state:'blocked',label:'Blocked',color:COMPANY_COLORS.blocked};
 if(agentWorking(agent,now,freshness))return{state:'working',label:agent.progress||'Actively working',color:COMPANY_COLORS.working};
 return{state:'idle',label:agent.status==='running'?'Waiting for worker':agent.status==='queued'?'Queued':agent.status==='recovering'?'Recovering':'Not running',color:COMPANY_COLORS.idle};
}
