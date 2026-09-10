const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
(async()=>{const root='/data',backup=root+'/backups/billing-hardening-20260910';fs.mkdirSync(backup,{recursive:true,mode:0o700});
 const files=fs.readdirSync(root).filter(n=>n.endsWith('.db')).map(n=>[path.join(root,n),n]);
 for(const dir of fs.readdirSync(root+'/workspaces',{withFileTypes:true}))if(dir.isDirectory()){const file=path.join(root,'workspaces',dir.name,'app.db');if(fs.existsSync(file))files.push([file,'workspace-'+dir.name+'.db']);}
 let count=0;for(const[file,name]of files){const destination=path.join(backup,name);if(fs.existsSync(destination))continue;const db=new Database(file,{readonly:true});try{await db.backup(destination);fs.chmodSync(destination,0o600);count++;}finally{db.close();}}
 console.log(JSON.stringify({backup,databases_backed_up:count,existing_backups_preserved:true}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
