const assert=require('node:assert/strict'),{readRange}=require('../server/github-read-range');
for(const start of [0,1,12]){const a={start_line:start,max_lines:100};const r=readRange(a);assert.equal(r.start_line,start||1);assert.equal(a.start_line,start);}
for(const start of [-1,1.5,'0',undefined])assert.throws(()=>readRange({start_line:start,max_lines:100}),/start_line/);
for(const size of [0,201,'100',undefined])assert.throws(()=>readRange({start_line:1,max_lines:size}),/max_lines/);
console.log('PASS: GitHub first-line recovery and range bounds');
