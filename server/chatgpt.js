const crypto=require('node:crypto'),express=require('express');
const fail=(status,message)=>Object.assign(Error(message),{status});
function createChatGPT({url,token}={},personal){
 const configured=!!(url&&token),account=user=>crypto.createHash('sha256').update(user).digest('hex');
 async function call(user,action,body){
  if(!configured)throw fail(503,'ChatGPT connections are temporarily unavailable. Please try again shortly.');
  let r;try{r=await fetch(`${url}/accounts/${account(user)}/${action}`,{method:action==='status'?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(action==='respond'||action==='test'?200000:35000)});}catch{throw fail(503,'The ChatGPT connector is temporarily unavailable. Your saved work is safe; try again shortly.');}
  const data=await r.json();if(!r.ok)throw fail(r.status,data.error||'ChatGPT could not complete this request');return data;
 }
 async function authorize(user){if(!(await call(user,'status')).connected)throw fail(401,'Connect your ChatGPT account in Account & AI, then resume this assignment');return{...personal.account(user),mode:'chatgpt'};}
 const router=express.Router();router.use('/api/ai/chatgpt',express.json({limit:'2kb'}));
 router.get('/api/ai/chatgpt',async(req,res,next)=>{try{res.json({configured,active:personal.account(req.cloudUserId).mode==='chatgpt',...(configured?await call(req.cloudUserId,'status'):{connected:false,pending:null})});}catch(e){next(e);}});
 for(const action of ['login','cancel','disconnect','test'])router.post('/api/ai/chatgpt/'+action,async(req,res,next)=>{try{
  const user=req.cloudUserId;
  const result=await call(user,action);
  // This actor can only change their personal connection, even in a shared
  // workspace. Workspace owners retain control of funding shared work.
  if(action==='disconnect'&&personal.account(user).mode==='chatgpt')personal.setMode(user,'none');
  res.json({configured,active:personal.account(user).mode==='chatgpt',...result});
 }catch(e){next(e);}});
 router.post('/api/ai/chatgpt/activate',async(req,res,next)=>{try{await authorize(req.cloudUserId);personal.setMode(req.cloudUserId,'chatgpt');res.json({ok:true});}catch(e){next(e);}});
 return{router,configured,authorize,respond:(a,id,payload)=>call(a.user_id,'respond',payload)};
}
module.exports={createChatGPT};
