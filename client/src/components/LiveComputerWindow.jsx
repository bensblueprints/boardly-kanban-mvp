import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Monitor,Minus,Maximize2,Minimize2,X,Hand,Play,Loader2,Keyboard} from 'lucide-react';
import {api} from '../api.js';
import DesktopInputQueue from '../computer-input-queue.js';
import DesktopDirect from '../computer-direct.js';

const button='inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400';
const ComputerWindowContext=createContext(null);
export function ComputerWindowButton(){
  const launch=useContext(ComputerWindowContext);
  return launch&&<button type="button" onClick={launch} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-400 px-3 py-2 text-sm text-indigo-100 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-indigo-400"><Monitor size={17}/>Open computer</button>;
}
const identity=item=>item?`${item.run_id||'manual'}:${item.project_id}:${item.desktop_id}`:'';
const keys={Enter:'Return',Escape:'Escape',Backspace:'BackSpace',Delete:'Delete',Insert:'Insert',Tab:'Tab',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down',Home:'Home',End:'End',PageUp:'Page_Up',PageDown:'Page_Down',' ':'space','-':'minus','+':'plus','=':'equal','.':'period',',':'comma','/':'slash'};
export default function LiveComputerWindow({workspaceId,children}) {
  const [items,setItems]=useState([]),[item,setItem]=useState(null),[open,setOpen]=useState(false),[maximized,setMaximized]=useState(false),[showKeys,setShowKeys]=useState(false);
  const [state,setState]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[frameAt,setFrameAt]=useState(null),[text,setText]=useState(''),[connectionLabel,setConnectionLabel]=useState('Connecting…'),[frameMs,setFrameMs]=useState(null);
  const dialog=useRef(null),canvas=useRef(null),stage=useRef(null),active=useRef(null),control=useRef(false),hasFrame=useRef(false),handoff=useRef(false),generation=useRef(0),down=useRef(null),abort=useRef(null),queue=useRef(null),refresh=useRef(()=>{}),handoffEpoch=useRef(0),direct=useRef(null);
  const storageKey='boardly-computer-windows:'+workspaceId;
  const dismissed=useRef(new Set());
  useEffect(()=>{try{dismissed.current=new Set(JSON.parse(sessionStorage.getItem(storageKey)||'[]'));}catch{}},[storageKey]);
  function stopDirect(){const old=direct.current;direct.current=null;old?.close();}
  function clearFrame(){hasFrame.current=false;setFrameAt(null);const c=canvas.current;if(c)c.getContext('2d').clearRect(0,0,c.width,c.height);}
  function fitFrame(){
    const c=canvas.current,s=stage.current;if(!c||!s)return;
    const scale=Math.min(s.clientWidth/c.width,s.clientHeight/c.height);
    // Size the actual canvas, so pointer coordinates exclude the surrounding bars.
    c.style.width=c.width*scale+'px';c.style.height=c.height*scale+'px';
  }
  function select(next){if(handoff.current||!next)return;generation.current++;stopDirect();abort.current?.abort();queue.current?.clear();control.current=false;setState(null);setError('');setNotice('');setText('');clearFrame();setItem(next);setOpen(true);}
  useEffect(()=>{
    let alive=true,loading=false;
    const load=async()=>{if(loading||document.visibilityState==='hidden')return;loading=true;
      try{const data=await api.get('/api/computeruse/activity');if(!alive)return;setItems(data.activity||[]);
        const next=(data.activity||[]).find(a=>!dismissed.current.has(identity(a))&&['running','blocked'].includes(a.status)&&Date.now()-a.updated_at<5*60*1000);
        if(next&&!dialog.current?.open)select(next);
      }catch{/* A workspace without computers has no automatic window. */}finally{loading=false;}
    };
    const manual=e=>{const d=e.detail;if(Number.isSafeInteger(d?.project_id)&&typeof d.desktop_id==='string')select(d);};
    load();const timer=setInterval(load,2000);window.addEventListener('boardly-open-computer',manual);
    return()=>{alive=false;clearInterval(timer);window.removeEventListener('boardly-open-computer',manual);};
  },[workspaceId]);
  function close(){generation.current++;stopDirect();abort.current?.abort();queue.current?.clear();control.current=false;clearFrame();setText('');for(const a of [...items,item].filter(Boolean))dismissed.current.add(identity(a));try{sessionStorage.setItem(storageKey,JSON.stringify([...dismissed.current].slice(-100)));}catch{}setOpen(false);setMaximized(false);}
  useEffect(()=>{const el=dialog.current;if(open&&item&&!el.open)el.showModal();else if(!open&&el.open)el.close();},[open,item]);
  useEffect(()=>{
    if(!open)return;
    const observer=new ResizeObserver(fitFrame);observer.observe(stage.current);fitFrame();
    const root=document.documentElement,overflow=root.style.overflow;root.style.overflow='hidden';
    return()=>{observer.disconnect();root.style.overflow=overflow;};
  },[open]);
  useEffect(()=>{
    if(!open||!item)return;
    const version=++generation.current,base=`/api/projects/${item.project_id}/computeruse/view/${encodeURIComponent(item.desktop_id)}`;
    active.current={...item,base};let alive=true,loading=false,lastStatus=0,timer,privateScreen=false,status=null,statusLoading=null,directRetryAt=0;
    const valid=()=>alive&&version===generation.current;
    setConnectionLabel('Connecting…');setFrameMs(null);
    const signal=(command,data)=>api.post(base+'/'+command,data);
    function tryDirect(){
      if(!valid()||handoff.current||privateScreen||!status?.direct_available||Date.now()<directRetryAt||direct.current&&!direct.current.closed)return;
      const connection=new DesktopDirect(signal,label=>{if(valid()&&direct.current===connection)setConnectionLabel(label);},{readOnly:!control.current});
      direct.current=connection;directRetryAt=Date.now()+15000;setConnectionLabel('Connecting directly…');
      void connection.connect().catch(()=>connection.close());
    }
    queue.current=new DesktopInputQueue({valid:()=>valid()&&control.current&&hasFrame.current,
      send:action=>{const data={operation_id:crypto.randomUUID(),action},connection=direct.current;return connection?.ready?connection.request('action',data):api.post(base+'/action',data);},
      onError:e=>{if(valid()){control.current=false;clearFrame();setError(e.message+' Input was not repeated.');lastStatus=0;}}
    });
    async function readStatus(){
      if(statusLoading)return statusLoading;
      const epoch=handoffEpoch.current;
      statusLoading=(async()=>{const result=await api.get(base);if(!valid()||epoch!==handoffEpoch.current)return;
        lastStatus=Date.now();status=result;setState(result);control.current=!!result.can_control;
        privateScreen=result.mode==='human'&&!result.can_control;
        if(privateScreen){stopDirect();clearFrame();return;}
        if(direct.current&&direct.current.readOnly===control.current){stopDirect();directRetryAt=0;}
        tryDirect();
      })().finally(()=>statusLoading=null);
      return statusLoading;
    }
    const load=async(force=false)=>{
      if(!valid()||loading||handoff.current||document.visibilityState==='hidden')return;loading=true;const epoch=handoffEpoch.current;const current=()=>valid()&&epoch===handoffEpoch.current&&!privateScreen;
      try{
        if(!status||force)await readStatus();
        else if(Date.now()-lastStatus>3000)void readStatus().catch(e=>{if(current()){privateScreen=true;status=null;stopDirect();control.current=false;clearFrame();setState(null);setError(e.message);}});
        if(!current()||privateScreen)return;
        tryDirect();const started=performance.now(),connection=direct.current;
        const controller=new AbortController();abort.current=controller;
        const blob=connection?.ready?await connection.request('screenshot'):await api.blob(base+'/screen',controller.signal);if(!current())return;
        const bitmap=await createImageBitmap(blob);
        if(current()&&canvas.current){const c=canvas.current;if(c.width!==bitmap.width||c.height!==bitmap.height){c.width=bitmap.width;c.height=bitmap.height;fitFrame();}c.getContext('2d').drawImage(bitmap,0,0);hasFrame.current=true;setFrameAt(Date.now());setFrameMs(Math.round(performance.now()-started));setError('');if(!direct.current||direct.current.closed)setConnectionLabel('Server connection');}bitmap.close();
      }catch(e){if(current()&&e.name!=='AbortError'){control.current=false;clearFrame();setError(e.message);lastStatus=0;}}
      finally{loading=false;}
    };
    refresh.current=()=>{lastStatus=0;directRetryAt=0;return load(true);};
    const wheel=e=>{if(!control.current||!hasFrame.current||handoff.current)return;e.preventDefault();queue.current.push({type:'scroll',direction:Math.abs(e.deltaX)>Math.abs(e.deltaY)?(e.deltaX>0?'right':'left'):(e.deltaY>0?'down':'up'),amount:Math.min(5,Math.max(1,Math.ceil(Math.abs(e.deltaY||e.deltaX)/100)))});};
    const screen=canvas.current;screen.addEventListener('wheel',wheel,{passive:false});
    const poll=async()=>{const started=performance.now();await load();if(valid())timer=setTimeout(poll,Math.max(15,(direct.current?.ready?80:250)-(performance.now()-started)));};poll();
    return()=>{alive=false;stopDirect();screen.removeEventListener('wheel',wheel);clearTimeout(timer);abort.current?.abort();queue.current?.clear();control.current=false;hasFrame.current=false;active.current=null;setText('');};
  },[open,identity(item)]);
  async function switchControl(command){
    const target=active.current;if(!target||handoff.current)return;
    handoff.current=true;handoffEpoch.current++;setBusy(true);setError('');setNotice('');
    try{
      await queue.current?.flush();stopDirect();control.current=false;clearFrame();abort.current?.abort();
      const result=await api.post(target.base+'/'+command,{});if(active.current===target)setState(s=>({...s,...result}));
      if(command==='resume'&&result.job?.can_resume){
        await api.post(`/api/chat/jobs/${result.job.id}/resume`,{content:'I explicitly clicked Give Back to Agent in the live computer window. Recheck the current desktop and saved work, then continue the authorized assignment. Do not repeat uncertain actions.'});
        if(active.current===target)setNotice('Control returned. Your agent is resuming the saved work.');
      }else if(active.current===target)setNotice(command==='takeover'?'You have control. Click the screen or type below.':'Control returned to the agent.');
    }catch(e){setError(e.message+' Checking the current control state before another action.');}
    finally{handoff.current=false;setBusy(false);refresh.current();}
  }
  function input(action){if(!handoff.current)queue.current?.push(action);}
  function point(e){const c=canvas.current,r=c.getBoundingClientRect();return{x:Math.max(0,Math.min(c.width-1,Math.floor((e.clientX-r.left)*c.width/r.width))),y:Math.max(0,Math.min(c.height-1,Math.floor((e.clientY-r.top)*c.height/r.height)))};}
  function keydown(e){if(!control.current||!hasFrame.current||handoff.current)return;e.preventDefault();e.stopPropagation();if(e.isComposing)return;
    if(e.key.length===1&&!e.ctrlKey&&!e.altKey&&!e.metaKey){input({type:'type',text:e.key});return;}
    const key=keys[e.key]||(/^(F([1-9]|1[0-2]))$/.test(e.key)?e.key:/^[a-zA-Z0-9]$/.test(e.key)?e.key.toLowerCase():null);
    if(key)input({type:'key',key:[e.ctrlKey?'ctrl':null,e.altKey?'alt':null,e.shiftKey?'shift':null,e.metaKey?'super':null,key].filter(Boolean).join('+')});
  }
  const human=state?.mode==='human',mine=human&&state?.can_control;
  return <ComputerWindowContext.Provider value={item&&!open?()=>select(item):null}>{children}{createPortal(<>
    <dialog ref={dialog} aria-label="Live computer window" onCancel={e=>{e.preventDefault();if(maximized)setMaximized(false);else close();}} className={`computer-live-window ${maximized?'computer-live-window-maximized':''} m-auto overflow-hidden rounded-2xl border border-zinc-600 bg-zinc-950 text-zinc-100 shadow-2xl backdrop:bg-black/50`}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="computer-window-header flex shrink-0 items-center gap-2 border-b border-zinc-800 p-2">
          <div className="flex min-w-0 flex-1 items-center gap-2"><Monitor className="hidden shrink-0 text-indigo-300 sm:block" size={20}/><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{item?.label||'Live computer'}</h2><p className="computer-project-name truncate text-xs text-zinc-400">{item?.project_name||state?.activity?.project_name||'Project computer'}</p></div></div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button className={button} aria-label="Minimize computer window" title={human?'Minimize window · agent stays paused':'Minimize window · agent keeps working'} disabled={busy} onClick={close}><Minus size={18}/><span>Minimize</span></button>
            <button className={button} aria-label={maximized?'Restore computer window':'Maximize computer window'} title={maximized?'Restore window (Esc)':'Maximize · fit desktop to screen'} onClick={()=>setMaximized(!maximized)}>{maximized?<Minimize2 size={18}/>:<Maximize2 size={18}/>}<span className="hidden sm:inline">{maximized?'Restore':'Maximize'}</span></button>
            <button className={button} aria-label="Close computer window" title="Close computer window" onClick={close}><X size={18}/></button>
          </div>
        </header>
        <div className="computer-control-bar flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 p-2"><p role="status" className={`mr-auto flex min-w-0 items-center gap-2 text-sm ${human?'text-amber-200':'text-emerald-300'}`}><span className={`h-2 w-2 shrink-0 rounded-full ${human?'bg-amber-300':'bg-emerald-400'}`}/>{!state?'Connecting to computer…':mine?'You have control · agent paused':human?'Someone else has control · agent paused':'Agent has control'}</p><button className={button+' border-amber-400/60'} disabled={busy||!state||human} onClick={()=>switchControl('takeover')}><Hand size={16}/>Take Over</button><button className={button+' border-indigo-400 bg-indigo-600/30'} disabled={busy||!mine} onClick={()=>switchControl('resume')}><Play size={16}/>Give Back to Agent</button>{busy&&<Loader2 size={16} className="animate-spin"/>}</div>
        {items.length>1&&<label className="flex min-w-0 shrink-0 items-center gap-2 px-2 pt-2 text-sm text-zinc-400">Computer<select aria-label="Live computer selection" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-zinc-100" value={items.some(a=>identity(a)===identity(item))?identity(item):''} onChange={e=>select(items.find(a=>identity(a)===e.target.value))}><option value="" disabled>Choose computer</option>{items.map(a=><option key={identity(a)} value={identity(a)}>{a.label} · {a.project_name}</option>)}</select></label>}
        <div className="computer-view-body flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-hidden p-1 sm:p-2"><div ref={stage} className="computer-view-stage relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black"><canvas ref={canvas} width="1280" height="800" tabIndex={mine?0:-1} aria-label="Live remote desktop" className={`block shrink-0 touch-none outline-none focus-visible:outline-2 focus-visible:outline-indigo-400 ${mine?'cursor-crosshair':'cursor-default'}`}
          onPointerDown={e=>{if(!control.current||!hasFrame.current||handoff.current)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);down.current={...point(e),button:e.button,desktop:item.desktop_id};}}
          onPointerUp={e=>{const start=down.current;down.current=null;if(!start||!control.current||!hasFrame.current||start.desktop!==item.desktop_id)return;const end=point(e);input(Math.hypot(start.x-end.x,start.y-end.y)>5&&start.button===0?{type:'drag',x:start.x,y:start.y,to_x:end.x,to_y:end.y}:{type:'click',...end,button:[1,2,3][start.button]||1});}}
          onPointerCancel={()=>down.current=null} onContextMenu={e=>e.preventDefault()} onKeyDown={keydown}
          onPaste={e=>{if(!control.current)return;e.preventDefault();const value=e.clipboardData.getData('text/plain');if(value&&value.length<=4096)input({type:'type',text:value});}}
          />
          {!frameAt&&<p className="pointer-events-none absolute px-5 text-center text-sm text-zinc-300">{human&&!mine?'The screen is private while someone else has control.':error?'Waiting for the computer connection…':'Loading the live screen…'}</p>}</div>
          <div className="flex min-w-0 shrink-0 items-center gap-2 text-xs text-zinc-400"><p className="min-w-0 flex-1 truncate" title={mine?'Click the screen to use your mouse and keyboard.':state?.activity?.progress||item?.progress}>{mine?'Mouse and keyboard ready':state?.activity?.progress||item?.progress||'Watching your agent work'}</p><span className="shrink-0" aria-label="Computer connection">{connectionLabel}{frameMs!==null?' · '+frameMs+' ms':''}</span>{connectionLabel==='Server connection'&&<button className="shrink-0 text-indigo-300 underline" title="Reconnect directly" onClick={()=>refresh.current()}>Reconnect</button>}</div>
          {error&&<p role="alert" className="shrink-0 text-sm text-rose-300">{error}</p>}{notice&&<p role="status" className="shrink-0 text-sm text-indigo-200">{notice}</p>}
        </div>
        {mine&&<form className="shrink-0 border-t border-zinc-800 p-2" onSubmit={e=>{e.preventDefault();if(text&&hasFrame.current){input({type:'type',text});setText('');}}}><div className="flex gap-2"><input aria-label="Text to type on computer" autoComplete="off" spellCheck={false} maxLength={4096} value={text} onChange={e=>setText(e.target.value)} placeholder="Type or paste into the computer…" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"/><button className={button} disabled={busy||!frameAt||!text}>Type</button><button type="button" className={button} aria-label="Keyboard shortcuts" title="Keyboard shortcuts" aria-expanded={showKeys} aria-controls="computer-keyboard-shortcuts" onClick={()=>setShowKeys(!showKeys)}><Keyboard size={18}/></button></div>{showKeys&&<div id="computer-keyboard-shortcuts" className="mt-2 flex flex-wrap gap-2">{[['Return','Enter'],['Tab','Tab'],['Escape','Esc'],['ctrl+l','Address bar'],['ctrl+v','Paste in desktop']].map(([key,label])=><button key={key} type="button" className={button} disabled={busy||!frameAt} onClick={()=>input({type:'key',key})}>{label}</button>)}</div>}<p className="mt-1 text-xs text-amber-200">Agent paused until you choose Give Back to Agent.</p></form>}
      </div>
    </dialog>
  </>,document.body)}</ComputerWindowContext.Provider>;
}
