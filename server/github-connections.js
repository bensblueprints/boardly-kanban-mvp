const crypto = require('node:crypto');
const express = require('express');
const { redact } = require('./project-environment');
const fail = (status, message) => Object.assign(Error(message), { status });
const shaPattern = /^[a-f0-9]{40}$/;

function repositoryName(value) {
  if (typeof value !== 'string') throw fail(400, 'Enter a GitHub repository URL or owner/repository');
  const name = value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9._-]{0,99}$/.test(name)) throw fail(400, 'Use a github.com repository URL or owner/repository');
  return name;
}
function branchName(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) || /\.\.|@\{|^[-/]|[/.]$|\/\/|(?:^|\/)\.|\.lock(?:\/|$)/.test(value) || value === '@') throw fail(400, 'Enter a valid Git branch name');
  return value;
}
function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git')) throw fail(400, 'Enter a relative repository file path');
  return value;
}
async function githubRequest(token, route, { method = 'GET', body } = {}) {
  let response;
  try { response = await fetch('https://api.github.com' + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Boardly', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }); } catch { throw fail(502, 'GitHub could not be reached. Check the repository state before retrying a write.'); }
  if (!response.ok) {
    const messages = { 401: 'GitHub rejected this token. Replace it with a valid token.', 403: 'GitHub denied access. Check token permissions, organization approval and rate limits.', 404: 'GitHub repository, branch or file was not found, or the token cannot access it.', 409: 'GitHub has conflicting changes. Read the current branch before retrying.', 422: 'GitHub rejected the change. The branch may have moved or require a pull request.' };
    await response.body?.cancel();
    throw fail(response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : response.status === 409 || response.status === 422 ? 409 : 502, messages[response.status] || 'GitHub could not complete this request. Inspect the repository before retrying.');
  }
  // Bound responses, including recursive trees and file blobs.
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 12 * 1024 * 1024) throw fail(413, 'GitHub response is too large. Read a narrower directory or smaller file.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(502, 'GitHub returned an unreadable response'); }
}

function createGithubConnections({ db, key, namespace, request = githubRequest }) {
  db.exec(`CREATE TABLE IF NOT EXISTS github_connections (
    id TEXT PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES boards(id) ON DELETE CASCADE, repository TEXT NOT NULL,
    branch TEXT NOT NULL, encrypted TEXT NOT NULL, allow_agent INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tested_at INTEGER,
    last_commit_sha TEXT, last_pushed_at INTEGER,
    CHECK((company_id IS NULL)!=(project_id IS NULL)));
    CREATE UNIQUE INDEX IF NOT EXISTS github_company ON github_connections(company_id) WHERE company_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS github_project ON github_connections(project_id) WHERE project_id IS NOT NULL;`);
  if(!db.prepare('PRAGMA table_info(github_connections)').all().some(c=>c.name==='credential_source'))db.exec("ALTER TABLE github_connections ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'scoped'");
  db.exec('CREATE TABLE IF NOT EXISTS github_account_credentials (id TEXT PRIMARY KEY,encrypted TEXT NOT NULL,updated_at INTEGER NOT NULL,tested_at INTEGER,login TEXT)');
  const columns = 'id,company_id,project_id,repository,branch,allow_agent,created_at,updated_at,tested_at,last_commit_sha,last_pushed_at,credential_source';
  const hierarchy = require('./hierarchy').createHierarchy(db);
  const field = kind => { if (!['companies', 'projects'].includes(kind)) throw fail(400, 'Invalid GitHub scope'); return kind === 'companies' ? 'company_id' : 'project_id'; };
  const scope = (kind, id) => { field(kind); if (!db.prepare(`SELECT id FROM ${kind === 'companies' ? 'companies' : 'boards'} WHERE id=?`).get(id)) throw fail(404, 'GitHub scope not found'); };
  const aad = row => Buffer.from(JSON.stringify(['github', namespace, row.id, row.company_id, row.project_id, row.repository, row.branch]));
  const decrypt = row => { const b = Buffer.from(row.encrypted, 'base64'), c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAAD(aad(row)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(); };
  const encrypt = (row, token) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(aad(row)); const b = Buffer.concat([c.update(token), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64'); };
  // Account credentials remain bound to this owner, and repository rows only hold a reference.
  const accountRow=()=>db.prepare("SELECT * FROM github_account_credentials WHERE id='account'").get();
  const accountBinding={id:'account',company_id:null,project_id:null,repository:'',branch:''};
  const validToken=token=>{if(typeof token!=='string'||token.length<20||token.length>2000||/\s|[^\x21-\x7e]/.test(token))throw fail(400,'Enter a valid GitHub personal access token');return token;};
  const accountState=()=>{const r=accountRow();return {has_token:!!r?.encrypted,updated_at:r?.updated_at||null,tested_at:r?.tested_at||null,login:r?.login||null};};
  function saveAccount(token){const old=accountRow();validToken(token);db.prepare("INSERT INTO github_account_credentials (id,encrypted,updated_at) VALUES ('account',?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at,tested_at=NULL,login=NULL").run(encrypt(accountBinding,token),Math.max(Date.now(),(old?.updated_at||0)+1));return accountState();}
  function credential(row){if(row.credential_source==='account'){const r=accountRow();return {token:r?.encrypted?decrypt({...accountBinding,encrypted:r.encrypted}):'',version:r?`account:${r.updated_at}`:'account:missing'};}return{token:decrypt(row),version:`scoped:${row.updated_at}`};}
  function describe(row){if(!row)return null;const account=row.credential_source==='account'?accountRow():null;return {...row,credential_ready:row.credential_source!=='account'||!!account?.encrypted,credential_version:row.credential_source==='account'?(account?`account:${account.updated_at}`:'account:missing'):`scoped:${row.updated_at}`,tested_at:row.credential_source==='account'&&(!account?.encrypted||row.tested_at<account.updated_at)?null:row.tested_at};}
  const direct = (kind, id) => { scope(kind, id); return describe(db.prepare(`SELECT ${columns} FROM github_connections WHERE ${field(kind)}=?`).get(id)); };
  function effective(projectId) {
    const own = direct('projects', projectId);
    // An explicitly paused project connection also overrides the company.
    if (own) return { ...own, inherited: false };
    const companyId = hierarchy.scope(projectId)?.company_id;
    const company = companyId == null ? null : direct('companies', companyId);
    return company ? { ...company, inherited: true } : null;
  }
  function save(kind, id, data) {
    const previous = direct(kind, id), old = previous && db.prepare('SELECT * FROM github_connections WHERE id=?').get(previous.id);
    const row = { id: old?.id || crypto.randomUUID(), company_id: kind === 'companies' ? Number(id) : null, project_id: kind === 'projects' ? Number(id) : null, repository: repositoryName(data.repository ?? old?.repository), branch: branchName(data.branch ?? old?.branch ?? 'main') };
    if (data.allow_agent !== undefined && typeof data.allow_agent !== 'boolean') throw fail(400, 'Agent access must be on or off');
    const source=data.credential_source??(data.token?'scoped':old?.credential_source||'account');
    if(!['account','scoped'].includes(source))throw fail(400,'Choose the account PAT or a separate repository token');
    const token=source==='account'?'':validToken(data.token||(old?.credential_source==='scoped'?decrypt(old):''));
    if(source==='account'&&data.token)throw fail(400,'Save the account PAT in Account & AI');
    db.prepare(`INSERT INTO github_connections (id,company_id,project_id,repository,branch,encrypted,allow_agent,created_at,updated_at,credential_source) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET repository=excluded.repository,branch=excluded.branch,encrypted=excluded.encrypted,allow_agent=excluded.allow_agent,updated_at=excluded.updated_at,tested_at=NULL,last_commit_sha=NULL,last_pushed_at=NULL,credential_source=excluded.credential_source`)
      .run(row.id,row.company_id,row.project_id,row.repository,row.branch,encrypt(row,token),data.allow_agent === undefined ? old?.allow_agent || 0 : Number(data.allow_agent),old?.created_at || Date.now(),Math.max(Date.now(),(old?.updated_at || 0)+1),source);
    return direct(kind, id);
  }
  const agentList = projectId => { const row = effective(projectId); return row?.allow_agent && row.credential_ready ? [row] : []; };
  // Rebuild this from durable settings for every conversation; never put the
  // encrypted credential or decrypted token in model context or UI summaries.
  function context(projectId) {
    const row=effective(projectId), location=hierarchy.scope(projectId);
    if(!row)return {status:'not_connected',saved:false};
    return {status:!row.credential_ready?'needs_token':row.allow_agent?'connected':'paused',saved:true,repository:row.repository,branch:row.branch,
      inherited:!!row.inherited,scope:row.inherited?'company':'project',
      scope_name:row.inherited?location?.company_name:location?.project_name,
      credential_source:row.credential_source,credential_ready:row.credential_ready,allow_agent:!!row.allow_agent,tested_at:row.tested_at,updated_at:row.updated_at};
  }
  function forJob(projectId, companyId, connectionId) {
    if (hierarchy.scope(projectId)?.company_id !== companyId) throw fail(403, 'Project company changed. Start a fresh Work run.');
    const row = effective(projectId);
    if (!row || row.id !== connectionId || !row.allow_agent) throw fail(403, 'This GitHub connection is not enabled for this project');
    if(!row.credential_ready)throw fail(403,'The company owner must add a GitHub PAT in Account & AI');
    return row;
  }
  async function operate(row, action, data = {}, valid = () => true) {
    const original = db.prepare('SELECT * FROM github_connections WHERE id=?').get(row.id);
    if (!original || original.updated_at !== row.updated_at) throw fail(403, 'GitHub connection changed. Read its settings again.');
    const auth=credential(original);if(!auth.token)throw fail(409,'Add the owner account GitHub PAT in Account & AI before connecting');
    if(row.credential_version&&row.credential_version!==auth.version)throw fail(403,'GitHub credential changed. Read its settings again.');
    const token = auth.token, prefix = '/repos/' + row.repository, started = Date.now();
    const current = () => { if(Date.now()-started>120000)throw fail(504,'GitHub operation timed out. Inspect the branch before retrying a write.'); const now = db.prepare('SELECT updated_at FROM github_connections WHERE id=?').get(row.id); if (!now || now.updated_at !== row.updated_at || credential(original).version!==auth.version || !valid()) throw fail(403, 'GitHub permission or run access was removed'); };
    const call = async (route, options) => { current(); const result = await request(token, prefix + route, options); current(); return result; };
    const head = async () => { const ref = await call('/git/ref/heads/' + encodeURIComponent(row.branch)); if (!shaPattern.test(ref.object?.sha)) throw fail(502, 'GitHub returned an invalid branch reference'); return ref.object.sha; };
    const clean = value => JSON.parse(redact(JSON.stringify(value), { token }));
    if (action === 'status' || action === 'test') {
      const repo = await call(''), sha = await head();
      if (action === 'test') db.prepare('UPDATE github_connections SET tested_at=? WHERE id=? AND updated_at=?').run(Date.now(), row.id, row.updated_at);
      return { repository: row.repository, branch: row.branch, sha, private: !!repo.private, can_push: repo.permissions?.push ?? null, url: 'https://github.com/' + row.repository };
    }
    if (action === 'list') {
      const sha = data.sha || await head(); if (!shaPattern.test(sha)) throw fail(400, 'Use a complete commit SHA');
      const directory = data.path ? filePath(data.path).replace(/\/$/, '') : '';
      const commit = await call('/git/commits/' + sha), tree = await call('/git/trees/' + commit.tree.sha + '?recursive=1');
      if (tree.truncated) throw fail(413, 'This repository tree is too large for this connector');
      return clean({ sha, files: tree.tree.filter(f => !directory || f.path.startsWith(directory + '/')).map(f => ({ path:f.path, type:f.type, mode:f.mode, sha:f.sha, size:f.size })) });
    }
    if (action === 'read') {
      const sha = data.sha || await head(); if (!shaPattern.test(sha)) throw fail(400, 'Use a complete commit SHA');
      const path = filePath(data.path), file = await call('/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + sha);
      if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 2 * 1024 * 1024) throw fail(413, 'Choose a regular file up to 2 MB');
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.includes(Buffer.from(token))) throw fail(400, 'This file contains the configured GitHub token. Remove the exposed credential from the repository.');
      return clean({ path, sha, blob_sha:file.sha, encoding:'base64', content:bytes.toString('base64'), size:bytes.length });
    }
    if (action === 'commit') {
      if (!shaPattern.test(data.base_sha || '')) throw fail(400, 'Read the branch first and supply its current commit SHA');
      if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2000) throw fail(400, 'Enter a commit message');
      if (redact(data.message, { token }) !== data.message) throw fail(400, 'Keep access tokens out of commit messages');
      if (!Array.isArray(data.files) || !data.files.length || data.files.length > 100) throw fail(400, 'Commit between 1 and 100 explicitly selected files');
      if (await head() !== data.base_sha) throw fail(409, 'GitHub has newer changes. Read and reconcile them before committing.');
      const previous = await call('/git/commits/' + data.base_sha), tree = [], seen = new Set(); let total = 0;
      for (const file of data.files) {
        const path = filePath(file.path);
        if (seen.has(path)) throw fail(400, 'A file can appear only once in a commit'); seen.add(path);
        if (/(^|\/)(\.env(?:\..*)?|\.ssh|\.codex|id_rsa|id_ed25519)(\/|$)/i.test(path) && !/(^|\/)\.env\.(example|sample|template)$/.test(path)) throw fail(400, 'Keep private environment and credential files out of GitHub');
        if (file.content === null) { tree.push({ path, mode:file.mode || '100644', type:'blob', sha:null }); continue; }
        if (typeof file.content !== 'string' || !['utf-8', 'base64'].includes(file.encoding || 'utf-8')) throw fail(400, 'Provide UTF-8 or base64 file contents');
        if (file.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw fail(400, 'Invalid base64 file contents');
        const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'); total += bytes.length;
        if (total > 4 * 1024 * 1024 || bytes.length > 2 * 1024 * 1024) throw fail(413, 'Limit each commit to 4 MB and each file to 2 MB');
        if (bytes.includes(Buffer.from(token)) || bytes.includes(Buffer.from(Buffer.from(token).toString('base64'))) || /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|bdly_[A-Za-z0-9_-]{35,}|sk_(?:live|test)_[A-Za-z0-9]{16,})/.test(bytes.toString())) throw fail(400, 'A selected file appears to contain a private access token');
        const mode = file.mode || '100644'; if (!['100644','100755'].includes(mode)) throw fail(400, 'Only regular files and executable files can be committed');
        const blob = await call('/git/blobs', { method:'POST',body:{content:bytes.toString('base64'),encoding:'base64'} });
        tree.push({ path, mode, type:'blob', sha:blob.sha });
      }
      const createdTree = await call('/git/trees', { method:'POST',body:{base_tree:previous.tree.sha,tree} });
      const commit = await call('/git/commits', { method:'POST',body:{message:data.message,tree:createdTree.sha,parents:[data.base_sha]} });
      // Never force a branch update. Concurrent commits and protected branches fail closed.
      await call('/git/refs/heads/' + encodeURIComponent(row.branch), { method:'PATCH',body:{sha:commit.sha,force:false} });
      if (await head() !== commit.sha) throw fail(409, 'GitHub advanced after the push. Inspect the current branch before deployment.');
      db.prepare('UPDATE github_connections SET last_commit_sha=?,last_pushed_at=? WHERE id=? AND updated_at=?').run(commit.sha,Date.now(),row.id,row.updated_at);
      return { pushed:true,sha:commit.sha,branch:row.branch,url:'https://github.com/'+row.repository+'/commit/'+commit.sha };
    }
    if (action === 'verify-deployment') {
      if (!shaPattern.test(data.sha || '')) throw fail(400, 'Supply the tested release commit SHA');
      const remote = await head();
      if (remote !== data.sha) throw fail(409, 'Deployment paused: the release commit is not the current GitHub branch. Push or reconcile changes first.');
      return { ready:true,repository:row.repository,branch:row.branch,sha:remote,verified_at:Date.now() };
    }
    throw fail(404, 'GitHub action not found');
  }
  const router = express.Router(); router.use(express.json({ limit:'16kb' }));
  // Repository discovery is broader than an assigned repository. Never enumerate
  // an owner's account or saved scoped PAT on behalf of a company member.
  router.post('/api/:kind(companies|projects)/:id/github/repositories',async(req,res,next)=>{try{
    scope(req.params.kind,req.params.id);
    const {credential_source:source='account',token:supplied,page=1,credential_version:expected}=req.body;
    if(!Number.isSafeInteger(page)||page<1||page>10000)throw fail(400,'Invalid repository page');
    if(!['account','scoped'].includes(source))throw fail(400,'Choose the account PAT or a separate repository token');
    if(!req.workspaceIsOwner&&(source==='account'||!supplied))throw fail(403,'Only the account owner can browse repositories using a saved PAT');
    let token,version,current;
    if(source==='account'){
      if(supplied)throw fail(400,'Save the account PAT in Account & AI');
      const account=accountRow();if(!account?.encrypted)throw fail(409,'Add your account GitHub PAT in Account & AI to browse repositories');
      token=decrypt({...accountBinding,encrypted:account.encrypted});version=`account:${account.updated_at}`;
      current=()=>accountRow()?.updated_at===account.updated_at;
    }else if(supplied){token=validToken(supplied);version='supplied';current=()=>true;
    }else{
      const saved=direct(req.params.kind,req.params.id);if(saved?.credential_source!=='scoped')throw fail(409,'Enter a separate GitHub token to browse its repositories');
      const raw=db.prepare('SELECT * FROM github_connections WHERE id=?').get(saved.id);token=decrypt(raw);version=`scoped:${saved.id}:${saved.updated_at}`;
      current=()=>{const now=direct(req.params.kind,req.params.id);return now?.id===saved.id&&now?.credential_version===saved.credential_version;};
    }
    if(expected!==undefined&&expected!==version)throw fail(409,'GitHub credential changed. Refresh the repository list.');
    const check=()=>{req.revalidateMember?.();scope(req.params.kind,req.params.id);if(!current())throw fail(403,'GitHub credential changed. Refresh the repository list.');};
    check();const rows=await request(token,`/user/repos?per_page=100&page=${page}&sort=full_name&direction=asc`);check();
    if(!Array.isArray(rows)||rows.length>100)throw fail(502,'GitHub returned an invalid repository list');
    // Return only picker metadata, never provider URLs, clone credentials or arbitrary fields.
    const repositories=rows.map(row=>{try{return {repository:repositoryName(row.full_name),default_branch:branchName(row.default_branch||'main'),private:!!row.private,archived:!!row.archived};}catch{throw fail(502,'GitHub returned invalid repository details');}});
    res.set('Cache-Control','no-store').json({repositories,credential_version:version,next_page:rows.length===100?page+1:null});
  }catch(e){next(e);}});
  router.use('/api/account/github',(req,res,next)=>req.workspaceIsOwner?next():res.status(403).json({error:'Only the account owner can manage the account GitHub PAT'}));
  router.get('/api/account/github',(req,res)=>res.json(accountState()));
  router.put('/api/account/github',(req,res)=>res.json(saveAccount(req.body.token)));
  // Keep the revision tombstone so delete/re-add cannot revive an in-flight operation.
  router.delete('/api/account/github',(req,res)=>{const old=accountRow();if(old)db.prepare("UPDATE github_account_credentials SET encrypted='',updated_at=?,tested_at=NULL,login=NULL WHERE id='account'").run(Math.max(Date.now(),old.updated_at+1));res.json({ok:true});});
  router.post('/api/account/github/test',async(req,res,next)=>{try{const old=accountRow();if(!old?.encrypted)throw fail(409,'Save an account GitHub PAT first');const user=await request(decrypt({...accountBinding,encrypted:old.encrypted}),'/user');if(accountRow()?.updated_at!==old.updated_at)throw fail(403,'The account GitHub PAT changed during the check');if(typeof user.login!=='string'||!/^[a-zA-Z0-9-]{1,39}$/.test(user.login))throw fail(502,'GitHub did not return an account name');db.prepare("UPDATE github_account_credentials SET login=?,tested_at=? WHERE id='account' AND updated_at=?").run(user.login,Date.now(),old.updated_at);res.json(accountState());}catch(e){next(e);}});

  router.get('/api/:kind(companies|projects)/:id/github', (req,res) => res.json({ can_manage_account:!!req.workspaceIsOwner,account_has_token:accountState().has_token,account_updated_at:req.workspaceIsOwner?accountState().updated_at:undefined,connection:direct(req.params.kind,req.params.id), effective:req.params.kind === 'projects' ? effective(Number(req.params.id)) : direct(req.params.kind,req.params.id), scope:req.params.kind==='projects'?hierarchy.scope(Number(req.params.id)):{company_name:db.prepare('SELECT name FROM companies WHERE id=?').get(req.params.id)?.name} }));
  router.put('/api/:kind(companies|projects)/:id/github', (req,res) => {
    const old=direct(req.params.kind,req.params.id),source=req.body.credential_source??(req.body.token?'scoped':old?.credential_source||'account'),repository=repositoryName(req.body.repository??old?.repository);
    // A scoped member may use an assigned repository, never repurpose an owner credential.
    if(!req.workspaceIsOwner){
      if(source==='account'&&(!old||old.credential_source!=='account'||old.repository!==repository))throw fail(403,'Only the account owner can assign a repository using the account GitHub PAT');
      if(old&&old.repository!==repository&&!req.body.token)throw fail(403,'Ask the owner to change this repository, or supply a separate token');
    }
    res.json(save(req.params.kind,req.params.id,req.body));
  });
  router.delete('/api/:kind(companies|projects)/:id/github', (req,res) => { direct(req.params.kind,req.params.id); db.prepare(`DELETE FROM github_connections WHERE ${field(req.params.kind)}=?`).run(req.params.id); res.json({ok:true}); });
  router.post('/api/:kind(companies|projects)/:id/github/test', async(req,res,next) => { try { const row = req.params.kind === 'projects' ? effective(Number(req.params.id)) : direct(req.params.kind,req.params.id); if (!row) throw fail(404,'Save a GitHub connection first'); res.json(await operate(row,'test',{},()=>{try{req.revalidateMember?.();return true;}catch{return false;}})); } catch(e) { next(e); } });
  router.use((e,req,res,next) => e.status ? res.status(e.status).json({error:e.message}) : next(e));
  async function run({projectId,companyId,connectionId,action,data={},valid=()=>true,ssh}) {
    const row = forJob(projectId,companyId,connectionId);
    const permitted = () => { try { const current=forJob(projectId,companyId,connectionId);return valid() && current.updated_at === row.updated_at && current.credential_version===row.credential_version; } catch { return false; } };
    if (action !== 'deploy') return operate(row,action,data,permitted);
    if (!ssh || typeof data.command !== 'string' || !data.command.trim() || data.command.length > 30000) throw fail(400,'Choose an enabled SSH connection and a production deployment command');
    if (typeof data.verification !== 'string' || data.verification.trim().length < 5 || data.verification.length > 5000) throw fail(400,'Record the checks passed for this exact release commit before deployment');
    const server = ssh.forJob(projectId,companyId,data.ssh_connection_id);
    const release = await operate(row,'verify-deployment',data,permitted);
    const result = await ssh.execute(server,{requireEnabled:true,command:`export BOARDLY_RELEASE_SHA='${release.sha}'; export BOARDLY_REPOSITORY='${row.repository}'; ${data.command}`,valid:() => { try { return permitted() && ssh.forJob(projectId,companyId,server.id).updated_at === server.updated_at; } catch { return false; } }});
    return { ...result,release,deployed:result.code === 0,verification:data.verification };
  }
  return { router,save,saveAccount,accountState,direct,effective,agentList,context,forJob,operate,run,redact:input => { let result = input; for (const row of db.prepare('SELECT * FROM github_connections').all()) result = redact(result,{token:decrypt(row)}); const account=accountRow();if(account?.encrypted)result=redact(result,{token:decrypt({...accountBinding,encrypted:account.encrypted})});return result; } };
}
module.exports = { createGithubConnections, githubRequest, repositoryName, branchName, filePath };
