import React,{useEffect,useRef,useState} from 'react';
import {UserRound,ChevronDown,Settings2,Plug,CreditCard,HelpCircle,LogOut,Download} from 'lucide-react';
import {accountSettings} from './SettingsShell.jsx';

export default function ProfileMenu({profile,access,onLogout,onHelp}) {
 const [open,setOpen]=useState(false),root=useRef(null),trigger=useRef(null),menu=useRef(null);
 const close=(focus=false)=>{setOpen(false);if(focus)trigger.current?.focus();};
 useEffect(()=>{if(!open)return;menu.current?.querySelector('[role="menuitem"]')?.focus();const outside=e=>{if(!root.current?.contains(e.target))close();};const route=()=>close();document.addEventListener('pointerdown',outside);window.addEventListener('hashchange',route);return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('hashchange',route);};},[open]);
 function keys(e){const items=[...menu.current.querySelectorAll('[role="menuitem"]')],index=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}else if(e.key==='Tab')close();}
 const choose=fn=>{close(true);fn();};
 const items=[[Settings2,'Settings',()=>accountSettings('profile')],...(access.workspaceOwner?[[Plug,'Connectors',()=>accountSettings('connectors')]]:[]),[CreditCard,'Billing & usage',()=>accountSettings('billing')],[Download,'Apps & devices',()=>accountSettings('apps')],[HelpCircle,'Help & tutorial',onHelp],[LogOut,'Sign out',onLogout]];
 return <div ref={root} className="relative">
  <button ref={trigger} aria-label="Open profile menu" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(v=>!v)} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);}}} className="flex items-center gap-2 rounded-full p-1 pr-2 border border-zinc-700 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
   {profile?.imageUrl?<img src={profile.imageUrl} alt="" className="h-8 w-8 rounded-full object-cover" referrerPolicy="no-referrer"/>:<span className="h-8 w-8 rounded-full bg-indigo-500/20 text-indigo-200 flex items-center justify-center"><UserRound size={18}/></span>}<ChevronDown size={14} className="text-zinc-400"/>
  </button>
  {open&&<div className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-32px)] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl z-[80] overflow-hidden">
   <div className="p-4 border-b border-zinc-800"><p className="font-medium text-sm truncate">{profile?.name||'Your Boardly account'}</p>{profile?.email&&<p className="text-xs text-zinc-400 mt-1 truncate">{profile.email}</p>}<span className="inline-block mt-2 text-xs text-indigo-300">{access.workspaceOwner?'Account owner':'Shared workspace'}</span></div>
   <div ref={menu} role="menu" aria-label="Profile" onKeyDown={keys} className="p-1.5">{items.map(([Icon,label,fn])=><button role="menuitem" key={label} onClick={()=>choose(fn)} className={'flex w-full gap-3 items-center rounded-lg px-3 py-2.5 text-sm text-left hover:bg-zinc-800 focus:bg-zinc-800 outline-none '+(label==='Sign out'?'text-rose-300 border-t border-zinc-800 mt-1':'text-zinc-200')}><Icon size={17} className="text-zinc-400"/>{label}</button>)}</div>
  </div>}
 </div>;
}
