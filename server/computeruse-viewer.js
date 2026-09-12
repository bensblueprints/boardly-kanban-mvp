const crypto = require('node:crypto');
const express = require('express');
const fail = (status, message) => Object.assign(Error(message), { status });
function createComputerViewer({ db, key, namespace, origin, connection, decrypt, unchanged, signature, assignment, rentals, desktopRequest, onHandoff }) {
  if (key && !/^[0-9a-f]{64}$/.test(key)) throw Error('Invalid ComputerUse viewer integration key');
  db.exec(`CREATE TABLE IF NOT EXISTS cu_desktop_activity (
    run_id TEXT NOT NULL, desktop_id TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    actor TEXT NOT NULL, label TEXT NOT NULL, action TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scope_signature TEXT NOT NULL,
    PRIMARY KEY(run_id,desktop_id))`);
  function record(projectId, actor, runId, desktop, action) {
    const now = Date.now();
    db.prepare(`INSERT INTO cu_desktop_activity VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,desktop_id)
      DO UPDATE SET action=excluded.action,updated_at=excluded.updated_at,scope_signature=excluded.scope_signature,label=excluded.label`).run(runId, desktop.desktop_id, projectId, actor, desktop.label || 'Computer', action, now, now,signature('project',projectId));
  }
  function activity(allowed) {
    return db.prepare(`SELECT a.*,j.status,j.progress,t.title,b.name AS project_name FROM cu_desktop_activity a
      JOIN chat_jobs j ON j.id=a.run_id JOIN chat_threads t ON t.id=j.thread_id JOIN boards b ON b.id=a.project_id
      WHERE a.updated_at>? ORDER BY a.updated_at DESC LIMIT 100`).all(Date.now()-30*60*1000)
      .filter(row => allowed(row.project_id) && assignment('project', row.project_id).rental_ids.length && signature('project',row.project_id)===row.scope_signature)
      .map(({actor,scope_signature,...row})=>row);
  }
  function latest(projectId,desktopId) {
    const row=db.prepare(`SELECT a.*,j.status,j.progress,t.title,b.name AS project_name FROM cu_desktop_activity a
      JOIN chat_jobs j ON j.id=a.run_id JOIN chat_threads t ON t.id=j.thread_id JOIN boards b ON b.id=a.project_id
      WHERE a.project_id=? AND a.desktop_id=? ORDER BY a.updated_at DESC LIMIT 1`).get(projectId,desktopId);
    if(!row||signature('project',projectId)!==row.scope_signature)return null;
    const {actor,scope_signature,...publicRow}=row;return publicRow;
  }
  let inventoryCache=null;
  async function request(projectId, actor, sessionId, command, data, valid) {
    if (!key) throw fail(503, 'The live computer viewer is being connected. Please try again shortly.');
    if (!['status','screenshot','takeover','resume','action'].includes(command) || typeof data.desktop_id !== 'string' || data.desktop_id.length > 128) throw fail(400,'Invalid computer request');
    valid(); const revision = connection()?.revision, scope = signature('project',projectId);
    const assigned = assignment('project',projectId);
    if(!inventoryCache || inventoryCache.revision!==revision || inventoryCache.expires<Date.now())inventoryCache={revision,expires:Date.now()+2000,items:await rentals(valid)};
    const inventory=inventoryCache.items;
    const selected = inventory.find(d=>d.desktop_id===data.desktop_id && assigned.rental_ids.includes(d.id) && d.state==='active');
    if (!selected) throw fail(403,'This computer is not assigned to the project');
    const check = () => { valid(); unchanged(revision); if(signature('project',projectId)!==scope) throw fail(403,'The computer assignment changed'); };
    check();
    const token = decrypt(connection()), now = Math.floor(Date.now()/1000);
    const hash = text => crypto.createHash('sha256').update(text).digest('hex');
    const payload = Buffer.from(JSON.stringify({aud:'computeruse-viewer-v1',iat:now,exp:now+30,nonce:crypto.randomUUID(),
      viewer_id:hash(JSON.stringify([namespace,actor,sessionId])),command,desktop_id:data.desktop_id,
      token_sha256:hash(token),body_sha256:hash(JSON.stringify(data))})).toString('base64url');
    const proof=payload+'.'+crypto.createHmac('sha256',Buffer.from(key,'hex')).update(payload).digest('hex');
    const result=await desktopRequest(origin,token,command,data,{'X-ComputerUse-Viewer':proof});
    check(); if(['takeover','resume'].includes(command))onHandoff(data.desktop_id);
    return result;
  }
  return {record,activity,latest,request,configured:!!key};
}
function registerViewerRoutes(router, verify) {
  function browser(req) {
    if(req.boardlyConnection || !req.cloudUserId || !req.cloudSessionId) throw fail(403,'Open the live computer window while signed in to Boardly');
  }
  const permitted=(req,id)=>{browser(req);verify(req,'project',id);};
  const allowed=(req,id)=>{try{permitted(req,id);return true;}catch{return false;}};
  router.get('/api/computeruse/activity',(req,res,next)=>{try{
    browser(req);res.set('Cache-Control','private, no-store');res.json({activity:req.tenant.computeruse.viewer.activity(id=>allowed(req,id))});
  }catch(e){next(e);}});
  const base='/api/projects/:id/computeruse/view/:desktopId';
  const handle=command=>async(req,res,next)=>{try{
    const id=Number(req.params.id),valid=()=>permitted(req,id);valid();
    const data={desktop_id:req.params.desktopId};
    if(command==='action') { data.operation_id=req.body?.operation_id; data.action=req.body?.action;
      if(typeof data.operation_id!=='string'||!/^[0-9a-f-]{36}$/.test(data.operation_id)||!data.action||JSON.stringify(data.action).length>20000)throw fail(400,'Invalid computer input'); }
    const result=await req.tenant.computeruse.viewer.request(id,req.cloudUserId,req.cloudSessionId,command,data,valid);
    res.set('Cache-Control','private, no-store');
    if(command==='screenshot'){
      if(!result?.image_url?.startsWith('data:image/jpeg;base64,'))throw fail(503,'The computer screen is unavailable');
      return res.type('image/jpeg').send(Buffer.from(result.image_url.slice(23),'base64'));
    }
    const recent=req.tenant.computeruse.viewer.latest(id,data.desktop_id);
    const job=recent?req.tenant.app.db.prepare('SELECT j.id,j.status,j.requested_by,t.id AS thread_id FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id WHERE j.id=?').get(recent.run_id):null;
    res.json({...result,activity:recent||null,job:job?{id:job.id,status:job.status,thread_id:job.thread_id,can_resume:['blocked','failed','interrupted'].includes(job.status)&&(req.workspaceIsOwner||job.requested_by===req.cloudUserId)}:null});
  }catch(e){next(e);}};
  router.get(base,handle('status'));router.get(base+'/screen',handle('screenshot'));
  for(const command of ['takeover','resume','action'])router.post(base+'/'+command,express.json({limit:'24kb'}),handle(command));
}
module.exports={createComputerViewer,registerViewerRoutes};
