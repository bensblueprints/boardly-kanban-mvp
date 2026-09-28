function companyOverview(db, clean = (_,text)=>text) {
  require('./hierarchy').ensureProjects(db);
  const companies = db.prepare('SELECT id,name FROM companies ORDER BY name COLLATE NOCASE').all();
  const boards = db.prepare('SELECT id,company_id,name FROM company_boards ORDER BY name COLLATE NOCASE').all();
  if (boards.some(b=>b.company_id==null)) companies.push({id:null,name:'Unassigned boards'});
  const projects = db.prepare(`SELECT p.workspace_id AS id,p.name,b.id AS board_id,b.name AS board_name,b.company_id,
    COUNT(c.id) AS total_tasks,
    COALESCE(SUM(CASE WHEN c.id IS NOT NULL AND lower(trim(l.name)) IN ('done','complete','completed','done awaiting revisions') THEN 1 ELSE 0 END),0) AS done_tasks,
    COALESCE(SUM(CASE WHEN c.id IS NOT NULL AND lower(trim(l.name))='blocked' THEN 1 ELSE 0 END),0) AS blocked_tasks,
    COALESCE(SUM(CASE WHEN c.id IS NOT NULL AND lower(trim(l.name))='in progress' THEN 1 ELSE 0 END),0) AS in_progress_tasks
    FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id
    LEFT JOIN lists l ON l.board_id=p.workspace_id AND l.archived=0
    LEFT JOIN cards c ON c.list_id=l.id AND c.archived=0
    GROUP BY p.workspace_id ORDER BY b.name,p.name`).all();
  const agents = db.prepare(`SELECT j.id,j.status,j.mode,j.runtime,j.progress,j.error,j.updated_at,j.started_at,j.swarm_id,
    t.board_id AS project_id,t.title,t.card_id,p.parent_board_id AS board_id,b.company_id,'project' AS kind
    FROM chat_jobs j JOIN chat_threads t ON t.id=j.thread_id
    JOIN company_projects p ON p.workspace_id=t.board_id JOIN company_boards b ON b.id=p.parent_board_id
    WHERE j.status IN ('queued','running','blocked','recovering') ORDER BY j.created_at,j.rowid`).all();
  const discussions = db.prepare(`SELECT j.id,j.status,j.mode,j.runtime,j.updated_at,j.started_at,j.error,t.title,
    CASE WHEN t.scope_type='company' THEN t.scope_id ELSE b.company_id END AS company_id,
    CASE WHEN t.scope_type='board' THEN t.scope_id ELSE NULL END AS board_id,
    NULL AS project_id,t.scope_type AS kind
    FROM discussion_jobs j JOIN discussion_threads t ON t.id=j.thread_id
    LEFT JOIN company_boards b ON t.scope_type='board' AND b.id=t.scope_id
    WHERE j.status IN ('queued','running','blocked','recovering') ORDER BY j.created_at,j.rowid`).all();
  for (const agent of [...agents,...discussions]) {
    const scope = projects.filter(p=>agent.project_id ? p.id===agent.project_id : agent.kind==='board' ? p.board_id===agent.board_id : p.company_id===agent.company_id);
    for (const key of ['title','progress','error']) if (agent[key]) agent[key]=scope.reduce((value,p)=>clean(p.id,value),agent[key]);
  }
  return {companies,boards,projects,agents:[...agents,...discussions],updated_at:Date.now(),freshness_ms:15000};
}
module.exports={companyOverview};
