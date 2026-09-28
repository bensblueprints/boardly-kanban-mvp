const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const home='/home/node/.codex';fs.mkdirSync(home,{recursive:true,mode:0o700});
for(const name of ['config.toml','AGENTS.md'])fs.copyFileSync('/home/node/.codex-defaults/'+name,path.join(home,name));
if(!fs.existsSync(path.join(home,'auth.json'))&&fs.existsSync('/run/secrets/codex-auth'))fs.copyFileSync('/run/secrets/codex-auth',path.join(home,'auth.json'));
for(const name of ['auth.json','config.toml','AGENTS.md'])if(fs.existsSync(path.join(home,name)))fs.chmodSync(path.join(home,name),0o600);
const child=spawn(process.execPath,['/app/scripts/codex-worker.cjs','/run/secrets/worker.json'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));
