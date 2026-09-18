// Store navigation metadata only. Workspace and user IDs isolate numeric board IDs.
const memory=new Map();
export const chatNavigationKey=(access,boardId)=>'boardly-chat:'+JSON.stringify([access.userId||'local',access.workspaceId||'local',boardId]);
export function readChatNavigation(key){
  try{const value=JSON.parse(sessionStorage.getItem(key)||'null');if(value&&typeof value.open==='boolean'&&(value.threadId===null||typeof value.threadId==='string'))return value;}catch{/* Storage can be disabled. */}
  return memory.get(key)||{open:false,threadId:null};
}
export function saveChatNavigation(key,value){
  const next={...readChatNavigation(key),...value};memory.set(key,next);
  try{sessionStorage.setItem(key,JSON.stringify(next));}catch{/* In-memory navigation still works. */}
}
