import React,{useState} from 'react';
import {Building2,FolderCog,Users,Plug,Download,Trash2} from 'lucide-react';
import {api} from '../api.js';
import SettingsShell,{settingsButton,settingsInput,accountSettings} from './SettingsShell.jsx';
import ConnectorCatalog,{connectorDefinitions} from './ConnectorCatalog.jsx';
import Members from './Members.jsx';
import GithubConnection from './GithubConnection.jsx';
import SshConnections from './SshConnections.jsx';
import ComputerUseAssignment from './ComputerUseAssignment.jsx';
import CompanyEmails from './CompanyEmails.jsx';
import ProjectEnvironment from './ProjectEnvironment.jsx';
import ProjectPayments from './ProjectPayments.jsx';

function GeneralSettings({kind,entity,owner,onSaved,onBack,onExport}){
 const company=kind==='company';
 const [name,setName]=useState(entity.hierarchy?.project_name||entity.name),[description,setDescription]=useState(entity.description||''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <div className="space-y-6">{error&&<p role="alert" className="text-rose-300 text-sm">{error}</p>}{notice&&<p role="status" className="text-emerald-300 text-sm">{notice}</p>}
  <form className="space-y-4" onSubmit={e=>{e.preventDefault();act(async()=>{await api.patch(`/api/${company?'companies':'projects'}/${entity.id}`,{name:name.trim()});if(!company)await api.patch(`/api/boards/${entity.id}`,{description});await onSaved?.();setNotice('Settings saved.');});}}>
   <label className="block text-sm">{company?'Company':'Project'} name<input required maxLength={200} readOnly={!owner} aria-label={`${company?'Company':'Project'} settings name`} className={settingsInput+' mt-2'} value={name} onChange={e=>setName(e.target.value)}/></label>
   {!company&&<label className="block text-sm">Description<textarea aria-label="Project settings description" rows={4} readOnly={!owner} className={settingsInput+' mt-2'} value={description} onChange={e=>setDescription(e.target.value)}/></label>}
   {owner?<button disabled={busy||!name.trim()} className={settingsButton+' bg-indigo-600'}>Save changes</button>:<p className="text-sm text-zinc-400">The account owner manages these details.</p>}
  </form>
  {!company&&entity.hierarchy&&<div className="rounded-xl border border-zinc-800 p-4 space-y-2"><h3 className="font-medium">Location</h3><p className="text-sm text-zinc-400">{entity.hierarchy.company_name||'Unassigned'} / {entity.hierarchy.parent_board_name}</p><a className="text-sm text-indigo-300" href={`#/collection/${entity.hierarchy.parent_board_id}`}>Open board to organize projects</a></div>}
  {onExport&&<div className="border-t border-zinc-800 pt-5 space-y-3"><h3 className="font-medium">Export project</h3><p className="text-sm text-zinc-400">Download this project’s board data as JSON. Download attachments separately from Files.</p><button className={settingsButton} onClick={onExport}><Download size={16}/>Export project</button></div>}
  {owner&&<details className="border border-rose-900/50 rounded-xl p-4"><summary className="cursor-pointer text-sm font-medium text-rose-300">Danger zone</summary><p className="text-sm text-zinc-400 my-3">{company?'Deleting this company moves its boards and projects to Unassigned and removes its connected mailboxes.':'Deleting this project permanently removes its tasks, chats, files and settings.'}</p><button disabled={busy} className={settingsButton+' text-rose-300'} onClick={()=>{if(!confirm(company?`Delete ${entity.name}? Its boards and projects will move to Unassigned. Connected email accounts will be removed.`:`Delete project ${entity.name} and all its tasks, chats, files and settings? This cannot be undone.`))return;act(async()=>{await api.del(`/api/${company?'companies':'boards'}/${entity.id}`);location.hash=company?'#/':`#/collection/${entity.hierarchy?.parent_board_id||''}`;});}}><Trash2 size={16}/>Delete {company?'company':'project'}</button></details>}
 </div>;
}

export default function ScopeSettings({kind,entity,section='general',owner,can,onSaved,onBack,onExport}){
 const company=kind==='company',scope=company?'Company':'Project',apiKind=company?'companies':'projects';
 const allowed=id=>id==='emails'?company&&owner:can(id==='computeruse'?'computers':id);
 const connectors=connectorDefinitions.filter(c=>(company?['github','computeruse','ssh','emails']:['github','computeruse','ssh','environment','payments']).includes(c.id)&&allowed(c.id));
 const sections=[
  {id:'general',label:'General',icon:company?Building2:FolderCog,description:`Name, ${company?'organization':'description and export'} and ${scope.toLowerCase()} management.`},
  ...(can('members')?[{id:'members',label:'Team & permissions',icon:Users,description:company?'Manage company members and the permissions they inherit in its projects.':'Manage project-only members and review inherited company access.'}]:[]),
  {id:'connectors',label:'Connectors',icon:Plug,description:`Tools and resources available to this ${scope.toLowerCase()}.`,keywords:'integrations'},
  ...connectors.map(c=>({...c,description:c.guide})),
 ];
 const select=id=>location.hash=`#/${company?'company':'board'}/${entity.id}/settings/${id}`;
 return <SettingsShell scope={scope} name={entity.hierarchy?.project_name||entity.name} sections={sections} section={section} onSelect={select} onBack={onBack}>
  {section==='general'&&<GeneralSettings key={kind+entity.id} kind={kind} entity={entity} owner={owner} onSaved={onSaved} onBack={onBack} onExport={onExport}/>}
  {section==='members'&&can('members')&&<Members embedded kind={apiKind} id={entity.id}/>}
  {section==='connectors'&&<><ConnectorCatalog key={kind+entity.id} scope={kind} entityId={entity.id} allowed={allowed} onSelect={select}/>{!connectors.length&&<p className="text-sm text-zinc-400">Ask the account owner for the connector permissions you need. Your project access is unchanged.</p>}{owner&&<button className={settingsButton} onClick={()=>accountSettings('connectors')}>Manage reusable account connections</button>}</>}
  {allowed(section)&&<>
   {section==='github'&&<GithubConnection kind={apiKind} id={entity.id}/>}
   {section==='ssh'&&<SshConnections kind={apiKind} id={entity.id}/>}
   {section==='computeruse'&&<ComputerUseAssignment kind={apiKind} id={entity.id}/>}
   {section==='emails'&&company&&<CompanyEmails companyId={entity.id}/>}
   {section==='environment'&&!company&&<ProjectEnvironment board={entity}/>}
   {section==='payments'&&!company&&<ProjectPayments board={entity}/>}
  </>}
 </SettingsShell>;
}
