const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
const root='/data',totals={chat_jobs:0,discussion_jobs:0,subscription_requests:0},jobs=[];
for(const entry of fs.readdirSync(root+'/workspaces',{withFileTypes:true})){
 const filename=path.join(root,'workspaces',entry.name,'app.db');if(!entry.isDirectory()||!fs.existsSync(filename))continue;
 const db=new Database(filename,{readonly:true});
 for(const table of Object.keys(totals))if(db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table',table))totals[table]+=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE status IN ('running','queued','recovering')`).get().n;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_jobs'").get())jobs.push(...db.prepare("SELECT status,runtime,worker_host,COUNT(*) n FROM chat_jobs WHERE status IN ('running','queued','recovering') GROUP BY status,runtime,worker_host").all());
 db.close();
}
const db=new Database(root+'/personal-ai.db',{readonly:true});
const counts={customers:db.prepare('SELECT COUNT(*) n FROM billing_customers').get().n,card_accounts:db.prepare("SELECT COUNT(*) n FROM ai_accounts WHERE mode='card'").get().n};db.close();
console.log(JSON.stringify({active_or_queued:totals,jobs,billing:counts}));
