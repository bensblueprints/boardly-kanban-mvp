const Database = require('better-sqlite3');
const { accessForMember } = require('./member-access');

// Discover companies using only this identity's live grants. Never initialize
// another workspace or expose private company names through the account picker.
function sharedCompanies(filename, grants) {
  if (!grants.length) return [];
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const tree = accessForMember(db, grants).filter({
      companies: db.prepare('SELECT id, name FROM companies').all(),
      boards: db.prepare('SELECT id, company_id FROM company_boards').all(),
      projects: db.prepare('SELECT workspace_id AS id, parent_board_id FROM company_projects').all(),
    });
    return tree.companies.map(company => {
      const boards = tree.boards.filter(board => board.company_id === company.id);
      const ids = new Set(boards.map(board => board.id));
      return { id: company.id, name: company.name, role: company.role,
        board_count: boards.length,
        project_count: tree.projects.filter(project => ids.has(project.parent_board_id)).length };
    });
  } finally { db.close(); }
}

module.exports = { sharedCompanies };
