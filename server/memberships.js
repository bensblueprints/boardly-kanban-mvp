const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const Database=require('better-sqlite3');
const fail=(status,message)=>Object.assign(Error(message),{status});
const normalize=email=>{if(typeof email!=='string'||email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))throw fail(400,'Enter a valid email address');return email.trim().toLowerCase();};
function createMemberships(root){
 fs.mkdirSync(root,{recursive:true});const db=new Database(path.join(root,'memberships.db'));fs.chmodSync(path.join(root,'memberships.db'),0o600);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');
 db.exec(`CREATE TABLE IF NOT EXISTS membership_accounts(owner_id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS account_members(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,email TEXT NOT NULL,user_id TEXT,name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen_at INTEGER,UNIQUE(owner_id,email),UNIQUE(owner_id,user_id));
 CREATE TABLE IF NOT EXISTS access_grants(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES account_members(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('company','project')),resource_id INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','editor')),created_at INTEGER NOT NULL,UNIQUE(member_id,kind,resource_id));
 CREATE INDEX IF NOT EXISTS membership_user ON account_members(user_id);
 CREATE INDEX IF NOT EXISTS grant_scope ON access_grants(kind,resource_id);`);
 const get=id=>db.prepare('SELECT * FROM account_members WHERE id=?').get(id);
 const role=value=>{if(!['viewer','editor'].includes(value))throw fail(400,'Choose Editor or Viewer');return value;};
 const usage=ownerId=>{const all=db.prepare('SELECT * FROM account_members WHERE owner_id=?').all(ownerId);return{users:1+all.length,active_users:1+all.filter(m=>m.status==='active').length,pending_users:all.filter(m=>m.status!=='active').length};};
 function prune(ownerId,tenantDb){
   db.transaction(()=>{db.prepare("DELETE FROM account_members WHERE status='provisioning' AND created_at<? AND NOT EXISTS(SELECT 1 FROM access_grants WHERE member_id=account_members.id)").run(Date.now()-300000);for(const grant of db.prepare('SELECT g.* FROM access_grants g JOIN account_members m ON m.id=g.member_id WHERE m.owner_id=?').all(ownerId)){
     const table=grant.kind==='company'?'companies':'boards';if(!tenantDb.prepare(`SELECT id FROM ${table} WHERE id=?`).get(grant.resource_id))db.prepare('DELETE FROM access_grants WHERE id=?').run(grant.id);
   }db.prepare("DELETE FROM account_members WHERE owner_id=? AND status!='provisioning' AND NOT EXISTS(SELECT 1 FROM access_grants WHERE member_id=account_members.id)").run(ownerId);})();
 }
 const reserve=db.transaction((ownerId,email,known,limit)=>{
   let member=db.prepare('SELECT * FROM account_members WHERE owner_id=? AND (email=? OR user_id=?)').get(ownerId,email,known?.id||null);
   if(member){if(member.status==='provisioning')throw fail(409,'This user is being added. Try again shortly.');return{member,fresh:false};}
   if(limit!=null&&usage(ownerId).users>=limit)throw fail(409,'This account has reached its included user allowance');
   const id=crypto.randomUUID();db.prepare('INSERT INTO account_members(id,owner_id,email,user_id,name,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id,ownerId,email,known?.id||null,known?.name||'','provisioning',Date.now());return{member:get(id),fresh:true};
 });
 async function add({ownerId,email,kind,resourceId,memberRole,limit,identity}){
   email=normalize(email);role(memberRole);
   let known;
   try { const response=await identity.users.getUserList({emailAddress:[email],limit:100});
     const found=response.data.find(u=>u.emailAddresses.some(a=>a.emailAddress.toLowerCase()===email));
     if(found){if(found.id===ownerId)throw fail(400,'The account owner already has access');
       // Do not grant an account access based on an unverified, user-added address.
       if(!found.emailAddresses.some(a=>a.emailAddress.toLowerCase()===email&&a.verification?.status==='verified')&&!db.prepare('SELECT id FROM account_members WHERE user_id=? AND email=?').get(found.id,email))throw fail(409,'This email is not verified. Ask the user to verify it before adding them.');
       known={id:found.id,name:[found.firstName,found.lastName].filter(Boolean).join(' ')};
     }
   }catch(e){if(e.status&&e.status<500)throw e;throw fail(502,'Could not look up this user. Try again shortly.');}
   const reservation=reserve.immediate(ownerId,email,known,limit);
   try{
     if(!known){
       const user=await identity.users.createUser({emailAddress:[email],emailAddressIdentificationStatus:['reserved'],username:'member_'+crypto.randomBytes(10).toString('hex'),skipPasswordRequirement:true});
       known={id:user.id,name:''};
     }
     return db.transaction(()=>{
       let member=db.prepare('SELECT * FROM account_members WHERE owner_id=? AND user_id=?').get(ownerId,known.id);
       if(member&&member.id!==reservation.member.id){if(reservation.fresh)db.prepare('DELETE FROM account_members WHERE id=?').run(reservation.member.id);}
       else {member=reservation.member;db.prepare("UPDATE account_members SET user_id=?,name=?,status=CASE WHEN status='active' THEN status ELSE 'pending' END WHERE id=?").run(known.id,known.name,member.id);}
       const id=crypto.randomUUID();db.prepare('INSERT INTO access_grants VALUES (?,?,?,?,?,?) ON CONFLICT(member_id,kind,resource_id) DO UPDATE SET role=excluded.role').run(id,member.id,kind,resourceId,memberRole,Date.now());
       return get(member.id);
     }).immediate();
   }catch(e){if(reservation.fresh)db.prepare("DELETE FROM account_members WHERE id=? AND status='provisioning'").run(reservation.member.id);if(e.status&&e.status<500)throw e;throw fail(502,'Could not finish adding the user. Retry with the same email address.');}
 }
 function grants(ownerId,userId){return db.prepare('SELECT g.* FROM access_grants g JOIN account_members m ON m.id=g.member_id WHERE m.owner_id=? AND m.user_id=?').all(ownerId,userId);}
 function list(ownerId,kind,resourceId){return db.prepare('SELECT m.id,m.email,m.name,m.status,m.last_seen_at,g.id AS grant_id,g.kind,g.resource_id,g.role FROM access_grants g JOIN account_members m ON m.id=g.member_id WHERE m.owner_id=? AND g.kind=? AND g.resource_id=? ORDER BY m.email').all(ownerId,kind,resourceId);}
 function update(ownerId,id,value){role(value);const g=db.prepare('SELECT g.* FROM access_grants g JOIN account_members m ON m.id=g.member_id WHERE g.id=? AND m.owner_id=?').get(id,ownerId);if(!g)throw fail(404,'Membership not found');db.prepare('UPDATE access_grants SET role=? WHERE id=?').run(value,id);}
 function remove(ownerId,id){const g=db.prepare('SELECT g.* FROM access_grants g JOIN account_members m ON m.id=g.member_id WHERE g.id=? AND m.owner_id=?').get(id,ownerId);if(!g)throw fail(404,'Membership not found');db.transaction(()=>{db.prepare('DELETE FROM access_grants WHERE id=?').run(id);if(!db.prepare('SELECT id FROM access_grants WHERE member_id=?').get(g.member_id))db.prepare('DELETE FROM account_members WHERE id=?').run(g.member_id);})();}
 function accounts(userId){return db.prepare("SELECT DISTINCT m.owner_id,COALESCE(a.name,'Shared account') AS name FROM account_members m JOIN access_grants g ON g.member_id=m.id LEFT JOIN membership_accounts a ON a.owner_id=m.owner_id WHERE m.user_id=? AND m.status!='provisioning' ORDER BY name,m.owner_id").all(userId);}
 return{db,usage,prune,add,grants,list,update,remove,accounts,
   label(ownerId,name){db.prepare('INSERT INTO membership_accounts VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET name=excluded.name').run(ownerId,name);},
   touch(userId){db.prepare("UPDATE account_members SET status='active',last_seen_at=? WHERE user_id=? AND status!='provisioning'").run(Date.now(),userId);},
   actor(ownerId,userId){return db.prepare('SELECT email,name FROM account_members WHERE owner_id=? AND user_id=?').get(ownerId,userId);},
   close(){db.close();}
 };
}
module.exports={createMemberships};
