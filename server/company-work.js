const { createHierarchy } = require('./hierarchy');
const fail = (status, message) => Object.assign(Error(message), { status });
const bounded = (value, max, label, optional = false) => {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw fail(400, `Invalid ${label}`);
  return value.trim();
};
const key = value => value.trim().toLocaleLowerCase('en-US');

// Additive, atomic setup. Never rename, move or overwrite existing work while
// constructing a team. Durable request keys protect retries across chat turns.
function createCompanyWork({ db, employees, clean }) {
  const hierarchy = createHierarchy(db);
  db.exec(`CREATE TABLE IF NOT EXISTS company_work_changes (
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL,
    job_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(company_id,request_key));`);
  function read(companyId) {
    const company = db.prepare('SELECT id,name,description FROM companies WHERE id=?').get(companyId);
    if (!company) throw fail(404, 'Company not found');
    const departments = db.prepare('SELECT id,name,description FROM company_boards WHERE company_id=? ORDER BY id').all(companyId);
    return { company, departments: departments.map(department => ({ ...department,
      boards: db.prepare('SELECT w.id,p.name,w.description FROM company_projects p JOIN boards w ON w.id=p.workspace_id WHERE p.parent_board_id=? ORDER BY w.id').all(department.id).map(board => ({ ...board,
        tasks: db.prepare('SELECT c.id,c.title,l.name AS status FROM cards c JOIN lists l ON l.id=c.list_id WHERE l.board_id=? AND c.archived=0 AND l.archived=0 ORDER BY c.id LIMIT 200').all(board.id),
        employees: db.prepare('SELECT id,name,role,instruction FROM project_employees WHERE board_id=? ORDER BY rowid').all(board.id)
      })) })) };
  }
  function build(companyId, jobId, args) {
    const requestKey = bounded(args.request_key, 80, 'request key');
    if (!/^[a-zA-Z0-9_-]+$/.test(requestKey)) throw fail(400, 'Use a stable request key containing letters, numbers, underscores or hyphens');
    if (!Array.isArray(args.departments) || !args.departments.length || args.departments.length > 12) throw fail(400, 'Supply 1–12 departments');
    let boardCount = 0, taskCount = 0;
    const unique = (rows, label) => { const seen = new Set(); for (const row of rows) { const name = key(row.name || row.title); if (seen.has(name)) throw fail(400, `Duplicate ${label} name`); seen.add(name); } return rows; };
    const departments = unique(args.departments.map(department => {
      const name = bounded(department.name, 200, 'department name');
      if (!Array.isArray(department.boards) || department.boards.length > 20) throw fail(400, 'Supply up to 20 boards per department');
      const boards = unique(department.boards.map(board => {
        boardCount++;
        if (!Array.isArray(board.tasks) || board.tasks.length > 50) throw fail(400, 'Supply up to 50 tasks per board');
        const tasks = unique(board.tasks.map(task => {
          taskCount++;
          return { title: bounded(task.title, 300, 'task title'), description: bounded(task.description, 10000, 'task description', true) };
        }), 'task');
        return { name: bounded(board.name, 200, 'board name'), description: bounded(board.description, 10000, 'board description', true), tasks };
      }), 'board');
      return { name, description: bounded(department.description, 10000, 'department description', true), boards };
    }), 'department');
    if (boardCount > 30 || taskCount > 150) throw fail(400, 'One setup can add up to 30 boards and 150 tasks');
    const requestJson = JSON.stringify(departments);
    return db.transaction(() => {
      if (!db.prepare('SELECT id FROM companies WHERE id=?').get(companyId)) throw fail(404, 'Company not found');
      const prior = db.prepare('SELECT * FROM company_work_changes WHERE company_id=? AND request_key=?').get(companyId, requestKey);
      if (prior) {
        if (prior.request_json !== requestJson) throw fail(409, 'This request key already identifies a different setup');
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
      const result = { company_id: companyId, departments: [], created: { departments: 0, boards: 0, tasks: 0 }, replayed: false };
      const match = (rows, name, label) => { const found = rows.filter(row => key(row.name || row.title) === key(name)); if (found.length > 1) throw fail(409, `Multiple existing ${label} entries match ${name}; resolve the duplicate names first`); return found[0]; };
      for (const department of departments) {
        let savedDepartment = match(db.prepare('SELECT id,name FROM company_boards WHERE company_id=?').all(companyId), department.name, 'department');
        if (!savedDepartment) { savedDepartment = hierarchy.createBoard({ ...department, company_id: companyId }); result.created.departments++; }
        const saved = { id: savedDepartment.id, name: savedDepartment.name, boards: [] }; result.departments.push(saved);
        for (const board of department.boards) {
          let savedBoard = match(db.prepare('SELECT workspace_id AS id,name FROM company_projects WHERE parent_board_id=?').all(saved.id), board.name, 'board');
          if (!savedBoard) { savedBoard = hierarchy.createProject({ ...board, parent_board_id: saved.id }); result.created.boards++; }
          const team = employees().ensure(savedBoard.id);
          const tasks = [];
          for (const task of board.tasks) {
            let savedTask = match(db.prepare('SELECT c.id,c.title FROM cards c JOIN lists l ON l.id=c.list_id WHERE l.board_id=? AND c.archived=0 AND l.archived=0').all(savedBoard.id), task.title, 'task');
            if (!savedTask) {
              let list = db.prepare("SELECT id FROM lists WHERE board_id=? AND lower(trim(name))='to do' AND archived=0 ORDER BY position,id LIMIT 1").get(savedBoard.id);
              if (!list) list = { id: db.prepare("INSERT INTO lists(board_id,name,position) VALUES(?,'To Do',0)").run(savedBoard.id).lastInsertRowid };
              const position = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM cards WHERE list_id=?').get(list.id).position;
              const id = Number(db.prepare('INSERT INTO cards(list_id,title,description,position) VALUES(?,?,?,?)').run(list.id, clean(savedBoard.id, task.title), clean(savedBoard.id, task.description), position).lastInsertRowid);
              savedTask = { id, title: task.title }; result.created.tasks++;
            }
            tasks.push(savedTask);
          }
          saved.boards.push({ id: savedBoard.id, name: savedBoard.name, tasks, employees: team.map(({ id, name, role }) => ({ id, name, role })) });
        }
      }
      db.prepare('INSERT INTO company_work_changes VALUES(?,?,?,?,?,?)').run(companyId, requestKey, requestJson, JSON.stringify(result), jobId, Date.now());
      return result;
    }).immediate();
  }
  return { read, build };
}

const text = { type: 'string' };
const task = { type: 'object', properties: { title: text, description: text }, required: ['title','description'], additionalProperties: false };
const board = { type: 'object', properties: { name: text, description: text, tasks: { type: 'array', items: task } }, required: ['name','description','tasks'], additionalProperties: false };
const department = { type: 'object', properties: { name: text, description: text, boards: { type: 'array', items: board } }, required: ['name','description','boards'], additionalProperties: false };
const tools = [
  { type: 'function', name: 'read_company_structure', description: 'Read this company, its departments, Boards, tasks and AI employee roles before planning changes.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'build_company_structure', description: 'Create the requested departments, Boards, tasks and AI employee rosters inside this company. Reuses exact names without overwriting existing work. Atomic and retry-safe: reuse request_key for the same setup. Does not hire humans, invite members or start ongoing automation. After setup, delegate explicitly requested work to task IDs using delegate_company_work.', parameters: { type: 'object', properties: { request_key: text, departments: { type: 'array', items: department } }, required: ['request_key','departments'], additionalProperties: false } }
];
module.exports = { createCompanyWork, tools };
