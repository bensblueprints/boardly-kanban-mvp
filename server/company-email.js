const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createHierarchy } = require('./hierarchy');
const { redact } = require('./project-environment');
const fail = (status,message) => Object.assign(Error(message),{status});
const blocked = new net.BlockList();
for (const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['198.18.0.0',15],['224.0.0.0',3]]) blocked.addSubnet(ip,bits,'ipv4');
function publicAddress(address) {
  if (net.isIP(address) === 4) return !blocked.check(address,'ipv4');
  return net.isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}
async function connectMailbox(config, operation, {resolve=dns.lookup,Client=ImapFlow}={}) {
  const addresses = await resolve(config.host,{all:true});
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw fail(400,'Use a public mail server with a valid TLS certificate');
  // Pin the resolved address to prevent DNS rebinding. Verify TLS for the configured hostname.
  const client = new Client({ host: addresses.find(a => a.family === 4)?.address || addresses[0].address,
    port:config.port, secure:true, tls:{servername:config.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},
    auth:{user:config.username,pass:config.password}, logger:false, emitLogs:false,
    disableAutoIdle:true, connectionTimeout:10000, greetingTimeout:10000, socketTimeout:15000 });
  client.on('error', () => {});
  const timeout = setTimeout(() => client.close(),30000);
  let lock;
  try { await client.connect(); lock = await client.getMailboxLock('INBOX',{readOnly:true}); return await operation(client); }
  finally { clearTimeout(timeout); lock?.release(); client.close(); }
}
function codes(text) {
  const found = new Set();
  // Extract only clearly labelled numeric codes, never arbitrary invoice numbers.
  for (const pattern of [/(?:verification|security|login|sign[ -]?in|one[ -]?time|authentication|confirmation|passcode|otp|code)[^\d\n]{0,60}\b(\d{4,8})\b/gi, /\b(\d{4,8})\b[^\d\n]{0,40}(?:is your|verification code|security code)/gi]) {
    for (const match of String(text).matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}
function createCompanyEmail({db,key,namespace,connector=connectMailbox}) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_mailboxes (
    id TEXT PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    label TEXT NOT NULL, email TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
    username TEXT NOT NULL, encrypted TEXT NOT NULL, allow_agent INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tested_at INTEGER
  )`);
  const hierarchy = createHierarchy(db), active = new Set(), sensitive = new Map();
  const columns = 'id,company_id,label,email,host,port,username,allow_agent,created_at,updated_at,tested_at';
  const list = companyId => db.prepare(`SELECT ${columns} FROM company_mailboxes WHERE company_id=? ORDER BY label,id`).all(companyId);
  const company = id => { if (!db.prepare('SELECT id FROM companies WHERE id=?').get(id)) throw fail(404,'Company not found'); };
  const row = (companyId,id) => { const r = db.prepare('SELECT * FROM company_mailboxes WHERE company_id=? AND id=?').get(companyId,id); if (!r) throw fail(404,'Company email not found'); return r; };
  const aad = (companyId,id) => Buffer.from(JSON.stringify(['company-email',namespace,Number(companyId),id]));
  function decrypt(r) {
    const raw = Buffer.from(r.encrypted,'base64'), cipher = crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
    cipher.setAAD(aad(r.company_id,r.id)); cipher.setAuthTag(raw.subarray(12,28));
    return Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString();
  }
  function save(companyId,data,id) {
    company(companyId); const old = id ? row(companyId,id) : null;
    if (!old && list(companyId).length >= 25) throw fail(400,'A company can connect up to 25 email accounts');
    if (data.allow_agent !== undefined && typeof data.allow_agent !== 'boolean' && ![0,1].includes(data.allow_agent)) throw fail(400,'Agent access must be on or off');
    const merged = {...old,...data};
    for (const field of ['label','email','host','username']) {
      if (typeof merged[field] !== 'string' || !merged[field].trim() || merged[field].length > 254 || /[\r\n\0]/.test(merged[field])) throw fail(400,`Enter a valid ${field}`);
      merged[field] = merged[field].trim();
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merged.email)) throw fail(400,'Enter a valid email address');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(merged.host) || !merged.host.includes('.')) throw fail(400,'Enter the public IMAP hostname');
    const port = Number(merged.port ?? 993);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400,'Enter a valid TLS IMAP port');
    const password = data.password || (old ? decrypt(old) : '');
    if (typeof password !== 'string' || !password || password.length > 4096 || password.includes('\0')) throw fail(400,'Enter the mailbox app password');
    id ||= crypto.randomUUID();
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(aad(companyId,id));
    const body = Buffer.concat([cipher.update(password),cipher.final()]);
    const encrypted = Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
    const changed = !old || data.password || ['host','port','username'].some(k => String(merged[k]) !== String(old[k]));
    db.prepare(`INSERT INTO company_mailboxes VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,email=excluded.email,host=excluded.host,port=excluded.port,username=excluded.username,encrypted=excluded.encrypted,allow_agent=excluded.allow_agent,updated_at=excluded.updated_at,tested_at=excluded.tested_at`)
      .run(id,companyId,merged.label,merged.email,merged.host.toLowerCase(),port,merged.username,encrypted,merged.allow_agent ? 1:0,old?.created_at || Date.now(),Date.now(),changed ? null : old.tested_at);
    return list(companyId).find(r => r.id === id);
  }
  function remember(text) { for (const code of codes(text)) sensitive.set(code,Date.now()); }
  function clean(text) {
    for (const [code,time] of sensitive) if (time < Date.now()-86400000) sensitive.delete(code);
    return redact(text,Object.fromEntries([...sensitive.keys()].map((v,i)=>[i,v])));
  }
  const metadata = (m,validity) => ({uid:m.uid,uid_validity:String(validity),subject:String(m.envelope?.subject || '').slice(0,500),
    from:(m.envelope?.from || []).map(a=>a.address).filter(Boolean),date:m.internalDate?.toISOString() || null,size:m.size || 0});
  async function read(client,uid,validity) {
    if (!Number.isSafeInteger(Number(uid)) || Number(uid) < 1 || String(client.mailbox.uidValidity) !== String(validity)) throw fail(409,'Inbox changed; refresh messages before reading');
    const m = await client.fetchOne(String(uid),{uid:true,envelope:true,internalDate:true,size:true},{uid:true});
    if (!m) throw fail(404,'Message not found');
    if (!m.size || m.size > 512000) throw fail(413,'This email is too large to preview (500 KB limit)');
    const source = await client.fetchOne(String(uid),{source:{maxLength:512001}},{uid:true});
    if (!source?.source || source.source.length > 512000) throw fail(413,'This email is too large to preview');
    const parsed = await simpleParser(source.source,{skipHtmlToText:false,skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:512000});
    const result = {...metadata(m,client.mailbox.uidValidity),text:String(parsed.text || '').slice(0,60000)};
    remember(result.subject+'\n'+result.text); return result;
  }
  async function operate(companyId,id,action,data={}, guard=()=>{}) {
    const r = row(companyId,id); guard(r);
    if (active.has(id) || active.size >= 4) throw fail(429,'Email is busy; try again shortly');
    active.add(id);
    try {
      const result = await connector({...r,password:decrypt(r)},async client => {
        if (action === 'test') return {ok:true,message:'Connected to inbox',messages:client.mailbox.exists};
        if (action === 'read') return read(client,data.uid,data.uid_validity);
        const total = client.mailbox.exists;
        const messages = total ? await client.fetchAll(`${Math.max(1,total-49)}:*`,{uid:true,envelope:true,internalDate:true,size:true}) : [];
        const ordered = messages.sort((a,b)=>b.uid-a.uid);
        if (action === 'list') return {messages:ordered.map(m=>metadata(m,client.mailbox.uidValidity))};
        if (action !== 'code') throw fail(404,'Email action not found');
        if (typeof data.sender !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.sender) || typeof data.subject !== 'string' || !data.subject.trim() || data.subject.length > 200) throw fail(400,'Specify the exact sender email and expected subject text');
        const since = Date.parse(data.since);
        if (!Number.isFinite(since) || since < Date.now()-15*60000 || since > Date.now()+30000) throw fail(400,'Use the sign-in request time from the last 15 minutes');
        const candidates = ordered.filter(m => m.internalDate?.getTime() >= since && m.internalDate.getTime() <= Date.now()+30000 && m.envelope?.from?.some(f=>f.address?.toLowerCase() === data.sender.toLowerCase()) && String(m.envelope.subject || '').toLowerCase().includes(data.subject.trim().toLowerCase()));
        if (!candidates.length) throw fail(404,'No matching verification email yet');
        const latest = candidates[0];
        const message = await read(client,latest.uid,String(client.mailbox.uidValidity));
        const matches = codes(message.subject+'\n'+message.text);
        if (matches.length !== 1) throw fail(409,'No single clear numeric code found; open the email to review');
        return {code:matches[0],uid:message.uid,uid_validity:message.uid_validity,received_at:message.date};
      });
      guard(row(companyId,id)); // Discard the response if access changed during network I/O.
      if (action === 'test') db.prepare('UPDATE company_mailboxes SET tested_at=? WHERE id=?').run(Date.now(),id);
      remember(JSON.stringify(result));
      return result;
    } catch (e) {
      if (e.status) throw e;
      throw fail(502,'Could not read this inbox. Check the IMAP host, TLS port and app password, and enable IMAP with your email provider.');
    } finally { active.delete(id); }
  }
  function agentList(projectId) {
    const s = hierarchy.scope(projectId);
    return s?.company_id ? list(s.company_id).filter(r=>r.allow_agent).map(({id,email,label})=>({id,email,label})) : [];
  }
  async function forJob(projectId,companyId,id,action,data,stillActive=()=>true) {
    if (companyId == null) throw fail(403,'No company email is enabled for this project');
    return operate(companyId,id,action,data,r => {
      if (!stillActive() || hierarchy.scope(projectId)?.company_id !== companyId || !r.allow_agent) throw fail(403,'Company email access changed. Start a new run after reviewing the project company.');
    });
  }
  const router = express.Router();
  router.use('/api/companies/:companyId/emails',express.json({limit:'16kb'}),(req,res,next)=>{res.setHeader('cache-control','private, no-store');next();});
  router.get('/api/companies/:companyId/emails',(req,res)=>{company(req.params.companyId);res.json(list(req.params.companyId));});
  router.post('/api/companies/:companyId/emails',(req,res)=>res.status(201).json(save(Number(req.params.companyId),req.body || {})));
  router.patch('/api/companies/:companyId/emails/:id',(req,res)=>res.json(save(Number(req.params.companyId),req.body || {},req.params.id)));
  router.delete('/api/companies/:companyId/emails/:id',(req,res)=>{row(req.params.companyId,req.params.id);db.prepare('DELETE FROM company_mailboxes WHERE id=?').run(req.params.id);res.json({ok:true});});
  router.post('/api/companies/:companyId/emails/:id/:action',async(req,res,next)=>{
    if (!['test','list','read'].includes(req.params.action)) return res.status(404).json({error:'Email action not found'});
    try {res.json(await operate(Number(req.params.companyId),req.params.id,req.params.action,req.body || {}));} catch(e){next(e);}
  });
  router.use((e,req,res,next)=>e.status ? res.status(e.status).json({error:e.message}):next(e));
  return {router,list,save,operate,agentList,forJob,clean};
}
module.exports = {createCompanyEmail,connectMailbox,publicAddress,codes};
