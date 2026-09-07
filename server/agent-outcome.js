const schema={type:'object',additionalProperties:false,required:['state','summary','next_step','blocker','next_action'],properties:{state:{type:'string',enum:['continue','completed','blocked']},summary:{type:'string'},next_step:{type:'string'},blocker:{type:'string'},next_action:{type:'string'}}};
function outcome(text){
 let value;try{value=JSON.parse(text);}catch{throw Error('The agent did not return a valid checkpoint');}
 if(!value||!['continue','completed','blocked'].includes(value.state)||!['summary','next_step','blocker','next_action'].every(k=>typeof value[k]==='string'&&value[k].length<=50000)||!value.summary.trim())throw Error('The agent checkpoint is incomplete');
 if(value.state==='continue'&&!value.next_step.trim())throw Error('The next working step is missing');
 if(value.state==='blocked'&&(!value.blocker.trim()||!value.next_action.trim()))throw Error('The blocker and required next action are missing');
 return value;
}
const instruction='This is a persistent Work assignment. Keep working through the authorized objective, using further working sessions when needed. Do not stop merely because you have proposed a plan, completed one intermediate step, or could offer to continue. Do not start unrelated backlog tasks. Your final response must match the checkpoint schema: state=continue with a concrete next_step when authorized work remains; state=completed only after the objective is actually achieved and verified; state=blocked only for missing input/access, an external dependency, a decision you cannot safely infer, or an issue you cannot resolve. Give a useful summary. For blocked include the exact blocker and next_action. A routine failed command is not a blocker. Continue any independent authorized work before blocking. Update relevant Boardly tasks, preserve existing context, and never include secrets in checkpoints.';
module.exports={schema,outcome,instruction};
