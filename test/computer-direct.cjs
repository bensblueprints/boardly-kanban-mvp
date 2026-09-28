const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const sandbox={window:{},crypto:crypto.webcrypto,Blob,ArrayBuffer,setTimeout,clearTimeout};vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('client/src/computer-direct.js','utf8').replace('export default class DesktopDirect {','window.DesktopDirect=class {'),sandbox);
function connection(){
 const direct=new sandbox.window.DesktopDirect(()=>Promise.resolve(),()=>{}),sent=[];
 direct.channel={readyState:'open',send:raw=>sent.push(JSON.parse(raw))};direct.pc={close(){}};
 return {direct,sent};
}
test('reassembles bounded JPEG chunks for the matching frame request',async()=>{
 const {direct,sent}=connection(),reply=direct.request('screenshot');
 direct.message(JSON.stringify({id:sent[0].id,bytes:4}));
 direct.message(new Uint8Array([255,216]).buffer);direct.message(new Uint8Array([255,217]).buffer);
 const blob=await reply;assert.equal(blob.type,'image/jpeg');assert.equal(blob.size,4);direct.close();
});
test('disconnect rejects an outstanding action exactly once without replay',async()=>{
 const {direct,sent}=connection(),reply=direct.request('action',{operation_id:crypto.randomUUID(),action:{type:'key',key:'Return'}});
 direct.close();direct.close();await assert.rejects(reply,/not retried/);assert.equal(sent.length,1);
});
test('oversized frames close the connection instead of allocating unbounded memory',async()=>{
 const {direct,sent}=connection(),reply=direct.request('screenshot');
 direct.message(JSON.stringify({id:sent[0].id,bytes:2000001}));await assert.rejects(reply);assert.equal(direct.ready,false);
});
test('input error never triggers a fallback resend',async()=>{
 const {direct,sent}=connection(),reply=direct.request('action',{operation_id:crypto.randomUUID(),action:{type:'key',key:'Return'}});
 direct.message(JSON.stringify({id:sent[0].id,error:'uncertain'}));await assert.rejects(reply,/uncertain/);assert.equal(sent.length,1);direct.close();
});

test('read-only direct client rejects input before any network send',async()=>{const {direct,sent}=connection();direct.readOnly=true;await assert.rejects(direct.request('action',{operation_id:crypto.randomUUID(),action:{type:'key',key:'Return'}}),/Take over/);assert.equal(sent.length,0);direct.close();});
