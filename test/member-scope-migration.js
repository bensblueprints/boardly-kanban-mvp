const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),D=require('better-sqlite3');
const {createMemberships}=require('../server/memberships');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'member-scope-migration-'));
try{
 const legacy=new D(path.join(root,'memberships.db'));
 legacy.exec(`CREATE TABLE membership_accounts(owner_id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE account_members(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,email TEXT NOT NULL,user_id TEXT,name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen_at INTEGER,UNIQUE(owner_id,email),UNIQUE(owner_id,user_id));
 CREATE TABLE access_grants(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES account_members(id) ON DELETE CASCADE,kind TEXT NOT NULL,resource_id INTEGER NOT NULL,role TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(member_id,kind,resource_id));
 INSERT INTO account_members VALUES ('m','user_owner','member@example.com','user_member','Member','active',1,2);
 INSERT INTO access_grants VALUES ('g','m','company',13,'editor',3);`);
 const original=legacy.prepare('SELECT * FROM access_grants').get(),member=legacy.prepare('SELECT * FROM account_members').get();legacy.close();
 let migrated=createMemberships(root);const row=migrated.db.prepare('SELECT * FROM access_grants').get();
 for(const [key,value]of Object.entries(original))assert.equal(row[key],value);
 assert.deepEqual(migrated.db.prepare('SELECT * FROM account_members').get(),member);assert.equal(row.scopes,'[]');assert.equal(row.scope_company_id,null);assert.equal(migrated.db.pragma('integrity_check',{simple:true}),'ok');
 migrated.setScopes('user_owner','g',['ssh'],'user_owner');migrated.close();migrated=createMemberships(root);
 assert.deepEqual(migrated.grants('user_owner','user_member')[0].scopes,['ssh']);assert.equal(migrated.db.prepare('SELECT COUNT(*) n FROM member_scope_events').get().n,1);migrated.close();
 console.log('PASS: legacy membership rows preserved, scopes default off, audit and permissions persist across reopen');
}finally{fs.rmSync(root,{recursive:true,force:true});}
