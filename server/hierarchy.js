const express = require('express');
const crypto = require('node:crypto');
const error = (status, message) => Object.assign(Error(message), { status });
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw error(400, 'Enter a name up to 200 characters');
  return value.trim();
}
function installHierarchy(db) {
  // Legacy boards remain the project workspace so every task, secret and chat
  // keeps its IDs. Containers are additive, workspace-local organization.
  db.exec(`CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS company_boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS company_projects (
    workspace_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
    parent_board_id INTEGER NOT NULL REFERENCES company_boards(id) ON DELETE RESTRICT,
    name TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS projects_parent ON company_projects(parent_board_id);
  CREATE INDEX IF NOT EXISTS boards_company ON company_boards(company_id);`);
  ensureProjects(db);
}
function ensureProjects(db) {
  db.transaction(() => {
    for (const b of db.prepare('SELECT b.* FROM boards b LEFT JOIN company_projects p ON p.workspace_id=b.id WHERE p.workspace_id IS NULL').all()) {
      const id = db.prepare('INSERT INTO company_boards(uuid,name,description,created_at) VALUES (?,?,?,?)').run(crypto.randomUUID(), b.name, b.description, Date.now()).lastInsertRowid;
      db.prepare('INSERT INTO company_projects VALUES (?,?,?)').run(b.id, id, 'General');
    }
  })();
}
function createHierarchy(db) {
  const get = (table, id, label) => { const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id); if (!row) throw error(404, `${label} not found`); return row; };
  const scope = workspaceId => db.prepare(`SELECT p.workspace_id AS project_id,p.name AS project_name,b.id AS parent_board_id,b.name AS parent_board_name,c.id AS company_id,c.name AS company_name
    FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id LEFT JOIN companies c ON c.id=b.company_id WHERE p.workspace_id=?`).get(workspaceId) || null;
  function tree() {
    ensureProjects(db);
    return { companies: db.prepare('SELECT * FROM companies ORDER BY name COLLATE NOCASE,id').all(),
      boards: db.prepare('SELECT * FROM company_boards ORDER BY name COLLATE NOCASE,id').all(),
      projects: db.prepare(`SELECT p.workspace_id AS id,p.name,p.parent_board_id,w.uuid,w.description,w.color,w.emoji,w.starred,
        (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id=c.list_id WHERE l.board_id=w.id AND c.archived=0 AND l.archived=0) AS task_count
        FROM company_projects p JOIN boards w ON w.id=p.workspace_id ORDER BY w.starred DESC,p.name COLLATE NOCASE,w.id`).all() };
  }
  function createCompany(data) {
    const id = db.prepare('INSERT INTO companies(uuid,name,description,created_at) VALUES (?,?,?,?)').run(crypto.randomUUID(), name(data.name), String(data.description || '').slice(0,10000), Date.now()).lastInsertRowid;
    return get('companies', id, 'Company');
  }
  function updateCompany(id, data) {
    const old = get('companies', id, 'Company');
    db.prepare('UPDATE companies SET name=?,description=? WHERE id=?').run(data.name === undefined ? old.name : name(data.name), data.description === undefined ? old.description : String(data.description).slice(0,10000), id);
    return get('companies', id, 'Company');
  }
  function createBoard(data) {
    if (data.company_id != null) get('companies', data.company_id, 'Company');
    const id = db.prepare('INSERT INTO company_boards(uuid,company_id,name,description,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), data.company_id ?? null, name(data.name), String(data.description || '').slice(0,10000), Date.now()).lastInsertRowid;
    return get('company_boards', id, 'Board');
  }
  function updateBoard(id, data) {
    const old = get('company_boards', id, 'Board');
    const companyId = data.company_id === undefined ? old.company_id : data.company_id;
    if (companyId != null) get('companies', companyId, 'Company');
    db.prepare('UPDATE company_boards SET company_id=?,name=?,description=? WHERE id=?').run(companyId, data.name === undefined ? old.name : name(data.name), data.description === undefined ? old.description : String(data.description).slice(0,10000), id);
    return get('company_boards', id, 'Board');
  }
  const createProject = db.transaction(data => {
    get('company_boards', data.parent_board_id, 'Board');
    const projectName = name(data.name);
    const id = Number(db.prepare('INSERT INTO boards(name,description,color,emoji) VALUES (?,?,?,?)').run(projectName, String(data.description || '').slice(0,10000), '#6366f1', '📁').lastInsertRowid);
    db.prepare('INSERT INTO company_projects VALUES (?,?,?)').run(id, data.parent_board_id, projectName);
    ['To Do','In Progress','Blocked','Done'].forEach((n,i) => db.prepare('INSERT INTO lists(board_id,name,position) VALUES (?,?,?)').run(id,n,i));
    return { ...get('boards',id,'Project'), ...scope(id) };
  });
  function updateProject(id, data) {
    ensureProjects(db);
    const old = scope(id); if (!old) throw error(404, 'Project not found');
    const parent = data.parent_board_id ?? old.parent_board_id;
    get('company_boards', parent, 'Board');
    db.prepare('UPDATE company_projects SET parent_board_id=?,name=? WHERE workspace_id=?').run(parent, data.name === undefined ? old.project_name : name(data.name), id);
    return scope(id);
  }
  const router = express.Router();
  router.use(['/api/hierarchy','/api/companies','/api/company-boards','/api/projects'], express.json({limit:'32kb'}));
  router.get('/api/hierarchy', (req,res) => res.json(tree()));
  router.post('/api/companies', (req,res) => res.status(201).json(db.transaction(()=>{const limit=req.accountPlan?.companies;if(limit!=null&&db.prepare('SELECT COUNT(*) n FROM companies').get().n>=limit)throw error(409,'This account has reached its company allowance. Choose a larger plan.');return createCompany(req.body || {});}).immediate()));
  router.patch('/api/companies/:id', (req,res) => res.json(updateCompany(req.params.id,req.body || {})));
  router.delete('/api/companies/:id', (req,res) => {
    get('companies',req.params.id,'Company');
    db.prepare('DELETE FROM companies WHERE id=?').run(req.params.id); res.json({ok:true});
  });
  router.post('/api/company-boards', (req,res) => res.status(201).json(createBoard(req.body || {})));
  router.patch('/api/company-boards/:id', (req,res) => res.json(updateBoard(req.params.id,req.body || {})));
  router.delete('/api/company-boards/:id', (req,res) => {
    get('company_boards',req.params.id,'Board');
    if (db.prepare('SELECT workspace_id FROM company_projects WHERE parent_board_id=?').get(req.params.id)) throw error(409,'Move or delete the projects before deleting this board');
    db.prepare('DELETE FROM company_boards WHERE id=?').run(req.params.id); res.json({ok:true});
  });
  router.post('/api/projects', (req,res) => res.status(201).json(createProject(req.body || {})));
  router.patch('/api/projects/:id', (req,res) => res.json(updateProject(req.params.id,req.body || {})));
  router.use((e,req,res,next) => e.status ? res.status(e.status).json({error:e.message}) : next(e));
  return { router, tree, scope, createCompany, updateCompany, createBoard, updateBoard, createProject, updateProject };
}
module.exports = { installHierarchy, ensureProjects, createHierarchy };
