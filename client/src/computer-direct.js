'use strict';
// No account/guest secrets are sent over signaling candidates or stored locally.
// A lost input reply is never resent through the fallback transport.
export default class DesktopDirect {
 constructor(signal,onState,{readOnly=false}={}){this.readOnly=readOnly;this.signal=signal;this.onState=onState;this.pc=null;this.channel=null;this.id=null;this.pending=new Map();this.frame=null;this.closed=false;this.renewTimer=null;}
 get ready(){return !this.closed&&this.channel?.readyState==='open';}
 async connect(){
  if(!window.RTCPeerConnection)throw Error('Direct connection unsupported');
  const pc=this.pc=new RTCPeerConnection({iceServers:[]});
  const channel=this.channel=pc.createDataChannel('desktop',{ordered:true});channel.binaryType='arraybuffer';
  channel.onmessage=e=>this.message(e.data);
  channel.onclose=()=>this.close();channel.onerror=()=>this.close();
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))this.close();};
  await pc.setLocalDescription(await pc.createOffer());
  if(pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Local discovery timed out')),2500);
   pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};
  });
  const result=await this.signal('direct-connect',{sdp:pc.localDescription.sdp,read_only:this.readOnly});
  if(this.closed)throw Error('Direct connection closed');this.id=result.stream_id;if(this.readOnly&&(result.protocol!==2||result.read_only!==true))throw Error('Direct viewing is unavailable');
  await pc.setRemoteDescription({type:'answer',sdp:result.sdp});
  if(!this.ready)await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('No local direct route')),4500);
   channel.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
   channel.addEventListener('close',()=>{clearTimeout(timer);reject(Error('Direct connection closed'));},{once:true});
  });
  if(this.closed)throw Error('Direct connection closed');
  this.onState('Direct connection');this.renewTimer=setTimeout(()=>this.renew(),1500);
 }
 async renew(){
  if(this.closed)return;
  try{await this.signal('direct-renew',{stream_id:this.id,read_only:this.readOnly});if(!this.closed)this.renewTimer=setTimeout(()=>this.renew(),2500);}
  catch{this.close();}
 }
 request(command,data={}){
  if(this.readOnly&&command==='action')return Promise.reject(Error('Take over before sending input'));
  if(!this.ready)return Promise.reject(Error('Direct connection unavailable'));
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Direct response lost; input outcome may be uncertain'));this.close();},8000);
   this.pending.set(id,{resolve,reject,timer,command});
   try{this.channel.send(JSON.stringify({id,command,...data}));}
   catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
  });
 }
 message(data){
  if(this.closed)return;
  if(typeof data==='string'){
   let value;try{value=JSON.parse(data);}catch{this.close();return;}
   const pending=this.pending.get(value.id);if(!pending){this.close();return;}
   if(value.bytes!==undefined){
    if(pending.command!=='screenshot'||this.frame||!Number.isInteger(value.bytes)||value.bytes<1||value.bytes>2000000){this.close();return;}
    this.frame={id:value.id,total:value.bytes,size:0,chunks:[]};return;
   }
   clearTimeout(pending.timer);this.pending.delete(value.id);
   if(value.error)pending.reject(Error(value.error));else pending.resolve(value.result||value);
  }else if(data instanceof ArrayBuffer){
   const frame=this.frame;if(!frame||data.byteLength>16384||frame.size+data.byteLength>frame.total){this.close();return;}
   frame.chunks.push(data);frame.size+=data.byteLength;
   if(frame.size===frame.total){const pending=this.pending.get(frame.id);this.pending.delete(frame.id);this.frame=null;clearTimeout(pending.timer);pending.resolve(new Blob(frame.chunks,{type:'image/jpeg'}));}
  }else this.close();
 }
 close(){
  if(this.closed)return;this.closed=true;clearTimeout(this.renewTimer);
  for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Direct connection closed; input was not retried'));}
  this.pending.clear();this.frame=null;this.pc?.close();
  if(this.id)void this.signal('direct-close',{stream_id:this.id,read_only:this.readOnly}).catch(()=>{});
  this.onState('Server connection');
 }
};
