module.exports=page=>page.addInitScript(()=>{
 window.__rtcConnections=[];window.__rtcInputs=[];window.__rtcDropInput=false;
 class Channel extends EventTarget {
  constructor(pc){super();this.pc=pc;this.readyState='connecting';this.bufferedAmount=0;}
  close(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.();this.dispatchEvent(new Event('close'));}
  send(raw){const data=JSON.parse(raw);queueMicrotask(()=>{
   if(this.readyState!=='open')return;
   if(data.command==='screenshot'){
    const bytes=Uint8Array.from(atob(window.__rtcFrame.split(',')[1]),c=>c.charCodeAt(0));this.onmessage({data:JSON.stringify({id:data.id,bytes:bytes.length})});
    for(let i=0;i<bytes.length;i+=16384)this.onmessage({data:bytes.slice(i,i+16384).buffer});
   }else if(data.command==='action'){
    if(this.pc.readOnly){this.onmessage({data:JSON.stringify({id:data.id,error:'Read only'})});return;}
    window.__rtcInputs.push(data);if(window.__rtcDropInput){window.__rtcDropInput=false;this.close();return;}
    this.onmessage({data:JSON.stringify({id:data.id,result:{state:'completed'}})});
   }
  });}
 }
 window.RTCPeerConnection=class {
  constructor(){window.__rtcConnections.push(this);this.iceGatheringState='complete';this.connectionState='new';}
  createDataChannel(){return this.channel=new Channel(this);}
  async createOffer(){return {type:'offer',sdp:'synthetic offer'};}
  async setLocalDescription(d){this.localDescription=d;}
  async setRemoteDescription(d){this.readOnly=JSON.parse(d.sdp).read_only;this.connectionState='connected';this.channel.readyState='open';this.channel.dispatchEvent(new Event('open'));}
  close(){this.connectionState='closed';this.channel.close();}
 };
});
