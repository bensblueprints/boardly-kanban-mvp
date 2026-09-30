function readRange(args){
 const start=args.start_line==null||args.start_line===0?1:args.start_line;
 const size=args.max_lines==null?100:args.max_lines;
 if(!Number.isInteger(start)||start<1)throw Error('start_line must be an integer of 1 or greater. The first line is 1.');
 if(!Number.isInteger(size)||size<1)throw Error('max_lines must be a positive integer; each response contains at most 200 lines.');
 return {...args,start_line:start,max_lines:Math.min(size,200)};
}
async function readFile(args,read){
 const range=readRange(args),result=await read(range);
 const lines=Buffer.from(result.content,'base64').toString('utf8').split('\n');
 const selected=lines.slice(range.start_line-1,range.start_line-1+range.max_lines),text=selected.join('\n');
 // Do not skip the remainder of a long line when the character budget is hit.
 const truncated=text.length>40000;
 return {path:result.path,sha:result.sha,start_line:range.start_line,max_lines:range.max_lines,total_lines:lines.length,text:text.slice(0,40000),truncated,next_start_line:truncated?null:range.start_line+selected.length<=lines.length?range.start_line+selected.length:null};
}
module.exports={readRange,readFile};
