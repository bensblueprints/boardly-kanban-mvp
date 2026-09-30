function readRange(args){
 const start=args.start_line===0?1:args.start_line;
 if(!Number.isInteger(start)||start<1)throw Error('start_line must be an integer of 1 or greater. The first line is 1.');
 if(!Number.isInteger(args.max_lines)||args.max_lines<1||args.max_lines>200)throw Error('max_lines must be an integer from 1 to 200.');
 return {...args,start_line:start};
}
module.exports={readRange};
