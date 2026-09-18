'use strict';
// One ordered sender; input accumulated during a round trip is sent as a bounded batch.
export default class DesktopInputQueue {
 constructor({send,valid,onError,delay=25}){this.send=send;this.valid=valid;this.onError=onError;this.delay=delay;this.items=[];this.running=false;this.promise=Promise.resolve();}
 clear(){this.items=[];}
 push(action){
  if(!this.valid())return;
  const last=this.items.at(-1);
  if(action.type==='type'&&last?.type==='type'&&last.text.length+action.text.length<=4096)last.text+=action.text;
  else if(action.type==='scroll'&&last?.type==='scroll'&&last.direction===action.direction&&last.amount+action.amount<=10)last.amount+=action.amount;
  else this.items.push({...action});
  if(this.items.length>128){this.clear();this.onError(Error('Input is waiting on the connection. Refresh before continuing.'));return;}
  if(!this.running)this.start();
 }
 start(){
  this.running=true;
  this.promise=new Promise(resolve=>setTimeout(resolve,this.delay)).then(async()=>{
   while(this.items.length&&this.valid()){
    const actions=[];let textLength=0;
    while(this.items.length&&actions.length<16){const next=this.items[0],length=(next.text||'').length;if(textLength+length>4096)break;actions.push(this.items.shift());textLength+=length;}
    await this.send(actions.length===1?actions[0]:{type:'batch',actions});
   }
  }).catch(error=>{this.clear();this.onError(error);}).finally(()=>{this.running=false;if(this.items.length&&this.valid())this.start();});
 }
 async flush(){while(this.running)await this.promise;}
}
