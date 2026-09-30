const assert=require('node:assert/strict'),{fixture}=require('./member-fixture');
(async()=>{
 let modelCalls=0;
 const noAI=async()=>{modelCalls++;throw Error('No AI is available for this sync test');};
 const f=await fixture({providerRequest:noAI,providerConnectorRequest:noAI,openWebUIRequest:noAI});
 async function rpc(method,params){
  const res=await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+f.token('user_owner'),'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  assert.equal(res.status,200);const text=await res.text(),line=text.split('\n').find(l=>l.startsWith('data: '));const body=JSON.parse(line?line.slice(6):text);assert.ok(!body.error);return body.result;
 }
 async function tool(name,args){const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text);}
 try{
  const p=await f.project('Sync fixture','Sync board'),catalog=(await rpc('tools/list',{})).tools;
  for(const name of ['get_board','get_card','find_cards','file_upload_status']){const a=catalog.find(t=>t.name===name).annotations;assert.equal(a.readOnlyHint,true);assert.equal(a.destructiveHint,false);assert.equal(a.openWorldHint,false);}
  assert.equal(catalog.find(t=>t.name==='update_card').annotations.readOnlyHint,false);
  assert.equal(catalog.find(t=>t.name==='delete_card').annotations.destructiveHint,true);
  const card=await tool('create_card',{list_id:p.list.id,title:'Deterministic evidence sync'});
  await tool('update_card',{card_id:card.id,description:'Verification record copied by the MCP client. No model call.'});
  const saved=await tool('get_card',{card_id:card.id});assert.equal(saved.description,'Verification record copied by the MCP client. No model call.');
  const board=await f.api('/api/boards/'+p.project.id);assert.equal(board.lists.flatMap(l=>l.cards).find(c=>c.id===card.id).description,saved.description);
  assert.equal(modelCalls,0,'MCP data operations must not invoke AI');
  console.log('PASS: authenticated MCP card create/update/read and UI persistence with all AI providers unavailable; accurate read/write/destructive annotations.');
 }finally{await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
