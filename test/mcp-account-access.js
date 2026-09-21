const assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {fixture}=require('./member-fixture');

async function run(){
 const f=await fixture({publicAccess:true});
 try{
  const memberUser='user_member1';
  const owner=await f.project('Owner company','Owner project');
  const member=await f.project('Member company','Member project',memberUser);
  const memberKey=await f.api('/api/connections',{user:memberUser,method:'POST',body:{name:'Member Codex',scope:'mcp'}});
  assert.ok(memberKey.token);
  const listed=await f.api('/api/connections',{user:memberUser});
  assert.equal(listed.connections.length,1);
  const request=(workspace)=>({headers:{authorization:`Bearer ${memberKey.token}`,...(workspace?{'x-boardly-workspace':workspace}:{})}});
  const client=new Client({name:'member-mcp-test',version:'1'});
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:request()}));
   const boards=await client.callTool({name:'list_boards',arguments:{}});
   assert.equal(boards.isError,undefined);
   const own=JSON.parse(boards.content[0].text);
   assert.ok(own.some(b=>b.name===member.project.name));
   assert.ok(!own.some(b=>b.name===owner.project.name));
  }finally{await client.close();}
  console.log('member own MCP passed');
  const sharedGrant=await f.api(`/api/companies/${owner.company.id}/members`,{method:'POST',body:{email:'member@example.com',role:'viewer'}});
  assert.equal(sharedGrant.member.user_id,memberUser);
  const sharedClient=new Client({name:'member-shared-mcp-test',version:'1'});
  try{
   await sharedClient.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:request('user_owner')}));
   const boards=await sharedClient.callTool({name:'list_boards',arguments:{}});
   const shared=JSON.parse(boards.content[0].text);
   assert.ok(shared.some(b=>b.name===owner.project.name));
   const denied=await sharedClient.callTool({name:'create_project',arguments:{parent_board_id:owner.board.id,name:'Should be denied'}});
   assert.equal(denied.isError,true);
  }finally{await sharedClient.close();}
  const sync=await f.api('/api/connections',{user:memberUser,method:'POST',body:{name:'Member desktop',scope:'sync'}});
  assert.equal((await f.request('/api/sync/status',{user:memberUser})).status,403);
  await f.api('/api/connections/'+memberKey.id,{user:memberUser,method:'DELETE'});
  assert.equal((await fetch(f.base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${memberKey.token}`},body:'{}'})).status,401);
  console.log('PASS: non-owner MCP key, own workspace isolation, shared member workspace, sync separation and revocation');
 }finally{await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
