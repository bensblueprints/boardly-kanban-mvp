// Retry only rejected generations, never tool execution. Partial model output
// must not enter the conversation or become an action.
async function workResponse({provider,payload,respond,valid=()=>{},progress=()=>{}}){
 const budgets=provider==='deepseek'?[393216,393216]:[payload.max_output_tokens||4096];
 for(let attempt=0;attempt<budgets.length;attempt++){
  valid();
  const input=attempt?[...payload.input,{role:'developer',content:'Your previous response exceeded its output limit. None of its proposed actions ran. Continue from the existing verified state. Make ONE small tool call at a time; edit one file or a small section, use concise progress text, and avoid returning whole large files or batching file rewrites. Do not repeat earlier completed actions. This is not an access or funding blocker.'}]:payload.input;
  try{return await respond({...payload,input,max_output_tokens:budgets[attempt]});}
  catch(error){if(error.code!=='output_limit'||attempt===budgets.length-1)throw error;
   valid();progress('Adapting oversized AI response · smaller change at the maximum output budget');}
 }
}
function recoveryAction(error){
 if(error.code==='output_limit')return error.next_action;
 if(error.status===401||error.status===403)return 'Review the selected provider key and permissions, then resume this assignment.';
 if(error.code==='allowance_exhausted')return 'Restore the selected provider allowance or choose an enabled alternative, then resume.';
 return 'Review the reported error and saved activity, resolve that specific dependency, then resume the assignment.';
}
module.exports={workResponse,recoveryAction};
