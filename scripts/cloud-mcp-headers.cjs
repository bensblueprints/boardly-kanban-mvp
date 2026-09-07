#!/usr/bin/env node
const fs=require('node:fs');process.stdout.write(JSON.stringify({Authorization:'Bearer '+fs.readFileSync('/run/secrets/boardly-mcp-token','utf8').trim()}));
