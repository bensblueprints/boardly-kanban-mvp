const assert=require('node:assert/strict'),{readRange,readFile}=require('../server/github-read-range');
for(const start of [0,1,12]){const a={start_line:start,max_lines:100};const r=readRange(a);assert.equal(r.start_line,start||1);assert.equal(a.start_line,start);}
for(const start of [-1,1.5,'0'])assert.throws(()=>readRange({start_line:start,max_lines:100}),/start_line/);
for(const size of [0,-1,1.5,'100'])assert.throws(()=>readRange({start_line:1,max_lines:size}),/max_lines/);
assert.deepEqual(readRange({}),{start_line:1,max_lines:100});
assert.equal(readRange({start_line:0,max_lines:300}).max_lines,200);
(async()=>{
 const lines=Array.from({length:250},(_,i)=>'line '+(i+1));let reads=0;
 const read=async()=>{reads++;return {path:'src/app.js',sha:'a'.repeat(40),content:Buffer.from(lines.join('\n')).toString('base64')};};
 for(const args of [{},{start_line:0,max_lines:50},{start_line:0,max_lines:300}]){const r=await readFile(args,read);assert.ok(r.text.startsWith('line 1\n'));assert.ok(r.text.split('\n').length<=200);assert.equal(r.next_start_line,r.max_lines+1);}
 assert.equal((await readFile({start_line:201,max_lines:200},read)).next_start_line,null);
 await assert.rejects(readFile({start_line:-1},read),/start_line/);assert.equal(reads,4);
 console.log('PASS: recorded failing requests recover, pagination preserves line bounds, invalid reads do not reach GitHub');
})().catch(e=>{console.error(e);process.exitCode=1;});
console.log('PASS: GitHub first-line recovery and range bounds');
