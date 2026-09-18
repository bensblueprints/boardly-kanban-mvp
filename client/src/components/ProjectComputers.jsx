import React,{useEffect,useRef} from 'react';
import {Monitor,X} from 'lucide-react';
import ComputerUseAssignment from './ComputerUseAssignment.jsx';
export default function ProjectComputers({board,onClose}){
 const dialog=useRef(null);useEffect(()=>{const el=dialog.current;el.showModal();return()=>el.close();},[]);
 return <dialog ref={dialog} aria-label={`Computer use for ${board.name}`} onCancel={e=>{e.preventDefault();onClose();}} className="m-auto w-[calc(100%-24px)] max-w-2xl max-h-[90dvh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 text-zinc-100 p-0 backdrop:bg-black/70"><header className="flex items-center gap-3 border-b border-zinc-800 p-5"><Monitor className="text-indigo-300"/><div className="flex-1"><h2 className="font-semibold">Computer use</h2><p className="text-xs text-zinc-400">{board.name}</p></div><button aria-label="Close computer use" onClick={onClose}><X size={18}/></button></header><div className="p-5"><ComputerUseAssignment key={board.id} id={board.id} onOpenAccount={onClose}/></div></dialog>;
}
