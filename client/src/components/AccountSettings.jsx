import React,{useEffect,useRef,useState} from 'react';
import {UserRound,BrainCircuit,CreditCard,Plug,Download,Database,HelpCircle} from 'lucide-react';
import {api} from '../api.js';
import {useAccess} from '../access.jsx';
import SettingsShell,{settingsButton,settingsInput} from './SettingsShell.jsx';
import ConnectorCatalog,{connectorDefinitions} from './ConnectorCatalog.jsx';
import AccountFunding from './AccountFunding.jsx';
import MediaConnection from './MediaConnection.jsx';
import AIProviderConnection from './AIProviderConnection.jsx';
import OnePasswordConnection from './OnePasswordConnection.jsx';
import AccountGithub from './AccountGithub.jsx';
import AccountComputerUse from './AccountComputerUse.jsx';
import SshConnections from './SshConnections.jsx';
import TailscaleConnection from './TailscaleConnection.jsx';
import CloudConnections from './CloudConnections.jsx';
import ActivityMotion,{useActivityMotion} from './ActivityMotion.jsx';

function ScopeChooser({connector,onCancel}){
 const heading=useRef(null);useEffect(()=>{heading.current?.focus();heading.current?.scrollIntoView({block:'start'});},[]);
 const [data,setData]=useState(null),[company,setCompany]=useState(''),[project,setProject]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true;api.get('/api/hierarchy').then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 const companyOnly=connector==='emails',projects=data?.projects.filter(p=>data.boards.some(b=>b.id===p.parent_board_id&&String(b.company_id)===company))||[];
 return <section aria-label="Choose connector scope" className="rounded-xl border border-indigo-500/40 p-5 space-y-4"><h3 ref={heading} tabIndex={-1} className="font-semibold outline-none">Where should this connection be used?</h3><p className="text-sm text-zinc-400">{companyOnly?'A company inbox is shared with its projects.':'Environment secrets and purchase cards belong to an individual project.'}</p>{error&&<p role="alert" className="text-rose-300">{error}</p>}{!data&&!error&&<p className="text-sm text-zinc-400">Loading your companies…</p>}{data&&<><label className="block text-sm">Company<select aria-label="Connection company" value={company} onChange={e=>{setCompany(e.target.value);setProject('');}} className={settingsInput+' mt-2'}><option value="">Choose a company</option>{data.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{!companyOnly&&<label className="block text-sm">Project<select aria-label="Connection project" value={project} onChange={e=>setProject(e.target.value)} className={settingsInput+' mt-2'} disabled={!company}><option value="">Choose a project</option>{projects.map(p=><option key={p.id} value={p.id}>{data.boards.find(b=>b.id===p.parent_board_id)?.name} / {p.name}</option>)}</select></label>}<button className={settingsButton+' bg-indigo-600'} disabled={companyOnly?!company:!project} onClick={()=>location.hash=companyOnly?`#/company/${company}/settings/emails`:`#/board/${project}/settings/${connector}`}>Open {companyOnly?'company':'project'} settings</button>{!data.companies.length&&<p className="text-sm text-zinc-400">Create a company on Companies home first.</p>}</>}<button className={settingsButton+' ml-2'} onClick={onCancel}>Cancel</button></section>;
}

function ImportData(){
 const file=useRef(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function upload(value){if(!value)return;setBusy(true);setError('');try{const data=JSON.parse(await value.text()),result=await api.post('/api/boards/import',data);location.hash=`#/board/${result.id}`;}catch(e){setError('Import failed: '+e.message);}finally{setBusy(false);if(file.current)file.current.value='';}}
 return <div className="space-y-4"><h3 className="font-medium">Import a board</h3><p className="text-sm text-zinc-400">Upload a Boardly JSON export to create an imported project in this account. Existing projects remain in place.</p><input ref={file} type="file" accept=".json,application/json" aria-label="Boardly JSON file" onChange={e=>upload(e.target.files[0])} disabled={busy} className="block max-w-full text-sm"/>{busy&&<p role="status">Importing…</p>}{error&&<p role="alert" className="text-rose-300">{error}</p>}<div className="border-t border-zinc-800 pt-4"><h3 className="font-medium">Export a project</h3><p className="text-sm text-zinc-400 mt-2">Open the project, then Project settings → General → Export project. Files can be downloaded from that project’s Files tab.</p></div></div>;
}

export default function AccountSettings({onClose,initialSection='profile',profile,onManageProfile,onHelp}){
 const access=useAccess(),owner=access.workspaceOwner!==false,platformOwner=owner&&access.plan==='owner';
 const section=initialSection||'profile',select=id=>{location.hash=`#/settings/${id}`;};
 const [scopeConnector,setScopeConnector]=useState(null),[motion,setMotion]=useActivityMotion();
 useEffect(()=>{setScopeConnector(null);},[section]);
 const sections=[
  {id:'profile',label:'Profile & preferences',icon:UserRound,description:'Your identity, sign-in security and browser preferences.',keywords:'email password photo avatar security sessions animation'},
  {id:'ai',label:'AI & models',icon:BrainCircuit,description:'Choose the AI connection, model and spending settings for your own workspaces.',keywords:'ChatGPT Codex OpenAI API funding'},
  {id:'billing',label:'Billing & usage',icon:CreditCard,description:'Workspace plans, storage, user seats, invoices and subscription management.'},
  ...(owner?[{id:'connectors',label:'Connectors',icon:Plug,description:'Discover what Boardly can connect to and choose the right scope.',keywords:'integrations apps email SMTP IMAP cards secrets'}]:[]),
  ...connectorDefinitions.filter(c=>owner&&['github','computeruse','ssh','tailscale','onepassword','claude','kimi','local','fal','higgsfield'].includes(c.id)).map(c=>({...c,description:c.guide})),
  {id:'apps',label:'Apps & devices',icon:Download,description:'Download Boardly and manage supported desktop or external AI connections.',keywords:'MCP API sync download Windows Mac Linux'},
  ...(platformOwner?[{id:'mcp',label:'Developer & MCP',icon:Plug,description:'Create and revoke keys for external AI clients accessing this workspace.'}]:[]),
  ...(owner?[{id:'data',label:'Import & export',icon:Database,description:'Bring existing boards into your workspace and export project data.'}]:[]),
  {id:'help',label:'Help & getting started',icon:HelpCircle,description:'Find your way around Boardly and understand how access is organized.'},
 ];
 return <SettingsShell scope="Account" name={profile?.name||'Your account'} sections={sections} section={section} onSelect={select} onBack={onClose}>
  {section==='profile'&&<><div className="flex items-center gap-4">{profile?.imageUrl?<img src={profile.imageUrl} alt="Your profile" referrerPolicy="no-referrer" className="w-16 h-16 rounded-full"/>:<span className="w-16 h-16 bg-indigo-500/15 rounded-full flex items-center justify-center"><UserRound size={28}/></span>}<div className="min-w-0"><h3 className="font-semibold truncate">{profile?.name||'Your Boardly account'}</h3>{profile?.email&&<p className="text-sm text-zinc-400 break-all mt-1">{profile.email}</p>}<p className="text-xs text-indigo-300 mt-1">{owner?'Account owner':'Viewing a shared workspace'}</p></div></div><div className="rounded-xl border border-zinc-700 p-4 space-y-3"><h3 className="font-medium">Profile & sign-in security</h3><p className="text-sm text-zinc-400">Manage your profile photo, name, email addresses and available sign-in security options through your Boardly account.</p>{onManageProfile?<button className={settingsButton} onClick={onManageProfile}>Manage profile & security</button>:<p className="text-sm text-zinc-400">Profile management is available when signed in through Boardly’s website.</p>}</div><div className="space-y-3"><h3 className="font-medium">Activity animation</h3><p className="text-sm text-zinc-400">Control moving lines in company activity views. This preference is saved in this browser and initially follows your device’s reduced-motion setting.</p><ActivityMotion enabled={motion} onChange={setMotion}/></div></>}
  {['billing','ai'].includes(section)&&<AccountFunding key={section} section={section}/>}
  {owner&&section==='connectors'&&<>{scopeConnector&&<ScopeChooser key={scopeConnector} connector={scopeConnector} onCancel={()=>setScopeConnector(null)}/>}<ConnectorCatalog platformOwner={platformOwner} onSelect={select} onChooseScope={id=>setScopeConnector(id)}/></>}
  {owner&&['fal','higgsfield'].includes(section)&&<MediaConnection key={section} provider={section}/>}
  {owner&&['claude','kimi','local'].includes(section)&&<AIProviderConnection key={section} provider={section} platformOwner={platformOwner}/>}
  {owner&&section==='onepassword'&&<OnePasswordConnection/>}
  {owner&&section==='github'&&<AccountGithub/>}
  {owner&&section==='computeruse'&&<><AccountComputerUse/><a href="#/" className={settingsButton}>View computers & choose a company</a></>}
  {owner&&section==='ssh'&&<SshConnections kind="owner" id={0}/>}
  {owner&&section==='tailscale'&&<><TailscaleConnection/><button onClick={()=>select('ssh')} className={settingsButton}>Next: add an SSH computer</button></>}
  {(section==='apps'||section==='mcp'&&platformOwner)&&<CloudConnections key={section} embedded initialTab={section==='mcp'?'mcp':'downloads'} developerAccess={platformOwner}/>}
  {owner&&section==='data'&&<ImportData/>}
  {section==='help'&&<div className="space-y-5"><button className={settingsButton+' bg-indigo-600'} onClick={onHelp}>Open guided tutorial</button><div className="grid gap-4">{[['Your account','Manage your profile, AI funding, billing and reusable credentials from the profile menu.'],['Companies','Open a company’s Settings for its team and shared connectors. Company access includes the projects inside it.'],['Boards & projects','Boards group projects. Project settings manage specific repositories, computers, secrets, payment cards and project-only members.'],['Agents & permissions','Ask and Plan help you think. Work agents act with the permissions and connections you enable. Giving someone project access does not automatically grant every connector.']].map(([title,text])=><article className="border border-zinc-800 rounded-xl p-4" key={title}><h3 className="font-medium">{title}</h3><p className="text-sm text-zinc-400 mt-2">{text}</p></article>)}</div></div>}
 </SettingsShell>;
}
