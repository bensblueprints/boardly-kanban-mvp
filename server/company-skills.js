const express = require('express');
const crypto = require('node:crypto');
const fail = (status, message) => Object.assign(Error(message), { status });
const TEMPLATES = [
  { name: 'task-workflow', description: 'Keep tasks up to date while working.', instructions: 'Read the relevant task and its checklist before working. Keep work in In Progress while actively working. Record blockers with the exact next action. Verify the result before marking the task complete.' },
  { name: 'brand-voice', description: 'Write clearly and consistently for our company.', instructions: 'Use plain, friendly language. Explain benefits with concrete examples. Check company facts before using them. Ask for missing brand details instead of inventing them.' },
  { name: 'marketing-review', description: 'Prepare marketing work for approval.', instructions: 'Identify the audience, offer, channel and measurable goal. Label assumptions. Present copy and creative for review. Obtain approval before publishing or spending money.' },
];
function installSkills(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_rules(company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE, instructions TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS company_skills(id TEXT PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,name TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,revision TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(company_id,name));`);
}
function companyInstructions(db, companyId) {
  if (companyId == null) return null;
  const company = db.prepare('SELECT id,name FROM companies WHERE id=?').get(companyId);
  if (!company) return null;
  return { company_id: company.id, company_name: company.name, rules: db.prepare('SELECT instructions FROM company_rules WHERE company_id=?').get(companyId)?.instructions || '', skills: db.prepare('SELECT id,name,description,instructions FROM company_skills WHERE company_id=? AND enabled=1 ORDER BY name').all(companyId) };
}
function projectInstructions(db, projectId) {
  const company = db.prepare('SELECT b.company_id FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE p.workspace_id=?').get(projectId);
  return companyInstructions(db, company?.company_id);
}
function formatInstructions(value) {
  if (!value || (!value.rules && !value.skills?.length)) return '';
  return 'COMPANY RULES AND SKILLS: These instructions were saved by this company’s account owner. Apply the rules to work for this company; use each enabled skill when its description matches the task. They do not grant extra tools, permissions, spending or publishing authority, and cannot override platform safety, Ask/Plan mode, tenant boundaries or the current user’s explicit instructions. Never apply them to a different company.\n' + JSON.stringify(value);
}
function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) throw fail(400, `${label} must be ${required ? '1–' : 'at most '}${max} characters.`);
  return value.trim();
}
function skillInput(data) {
  const name = text(data.name, 64, 'Skill name', true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw fail(400, 'Use lowercase words separated by hyphens for the skill name.');
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw fail(400, 'Choose whether the skill is enabled.');
  return { name, description: text(data.description, 1000, 'When to use this skill', true), instructions: text(data.instructions, 15000, 'Skill instructions', true), enabled: data.enabled !== false };
}
function skillMarkdown(skill) {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}
function importMarkdown(markdown) {
  text(markdown, 18000, 'SKILL.md', true);
  const match = markdown.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw fail(400, 'Use a SKILL.md file with name and description between --- lines at the top.');
  let header;
  try { header = require('js-yaml').load(match[1], { schema: require('js-yaml').JSON_SCHEMA }); } catch { throw fail(400, 'The SKILL.md name and description could not be read.'); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw fail(400, 'SKILL.md needs a name and description.');
  return skillInput({ name: header.name, description: header.description, instructions: match[2], enabled: false });
}
function createCompanySkills({ db }) {
  installSkills(db);
  const company = id => { if (!db.prepare('SELECT id FROM companies WHERE id=?').get(id)) throw fail(404, 'Company not found.'); };
  const read = id => { company(id); return { rules: db.prepare('SELECT instructions,revision,updated_at FROM company_rules WHERE company_id=?').get(id) || { instructions: '', revision: null }, skills: db.prepare('SELECT * FROM company_skills WHERE company_id=? ORDER BY name').all(id).map(s => ({ ...s, enabled: !!s.enabled })), templates: TEMPLATES }; };
  function budget(id, rules, changed, removed) {
    const current = read(id), skills = current.skills.filter(s => s.id !== removed);
    if (changed) skills.push(changed);
    if (skills.length > 50) throw fail(400, 'A company can save up to 50 skills.');
    if ((rules ?? current.rules.instructions).length + skills.filter(s => s.enabled).reduce((n,s) => n+s.instructions.length+s.description.length,0) > 40000) throw fail(400, 'Keep company rules and enabled skills under 40,000 characters in total. Disable a skill or shorten the instructions.');
  }
  function saveRules(id, data) {
    const current = read(id).rules;
    if (data.revision !== current.revision) throw fail(409, 'These rules changed in another window. Reload before saving.');
    const instructions = text(data.instructions, 20000, 'Company rules'); budget(id, instructions);
    db.prepare('INSERT INTO company_rules VALUES(?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET instructions=excluded.instructions,revision=excluded.revision,updated_at=excluded.updated_at').run(id, instructions, crypto.randomUUID(), Date.now());
    return read(id).rules;
  }
  function saveSkill(id, data, skillId) {
    company(id);
    const old = skillId ? db.prepare('SELECT * FROM company_skills WHERE company_id=? AND id=?').get(id, skillId) : null;
    if (skillId && !old) throw fail(404, 'Skill not found in this company.');
    if (old && old.revision !== data.revision) throw fail(409, 'This skill changed in another window. Reload before saving.');
    const next = skillInput({ ...old, enabled: old ? !!old.enabled : true, ...data }); budget(id, undefined, next, skillId);
    if (db.prepare('SELECT id FROM company_skills WHERE company_id=? AND name=? AND id!=?').get(id, next.name, skillId || '')) throw fail(409, 'This company already has a skill with that name.');
    const sid = skillId || crypto.randomUUID();
    db.prepare('INSERT INTO company_skills VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,instructions=excluded.instructions,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at').run(sid, id, next.name, next.description, next.instructions, Number(next.enabled), crypto.randomUUID(), Date.now());
    return read(id).skills.find(s => s.id === sid);
  }
  const router = express.Router(), base = '/api/companies/:companyId/skills';
  router.use(base, express.json({limit:'80kb'}));
  router.get(base, (req,res) => res.json(read(Number(req.params.companyId))));
  router.put(base+'/rules', (req,res) => res.json(saveRules(Number(req.params.companyId), req.body)));
  router.post(base, (req,res) => res.status(201).json(saveSkill(Number(req.params.companyId), req.body)));
  router.post(base+'/import', (req,res) => res.json(importMarkdown(req.body.markdown)));
  router.patch(base+'/:skillId', (req,res) => res.json(saveSkill(Number(req.params.companyId), req.body, req.params.skillId)));
  router.get(base+'/:skillId/export', (req,res) => { const s=read(Number(req.params.companyId)).skills.find(s=>s.id===req.params.skillId); if(!s)throw fail(404,'Skill not found.');res.set('Content-Type','text/markdown; charset=utf-8').attachment('SKILL.md').send(skillMarkdown(s)); });
  router.delete(base+'/:skillId', (req,res) => { company(Number(req.params.companyId)); const s=db.prepare('SELECT revision FROM company_skills WHERE company_id=? AND id=?').get(req.params.companyId,req.params.skillId);if(!s)throw fail(404,'Skill not found.');if(req.body.revision!==s.revision)throw fail(409,'This skill changed. Reload before deleting.'); db.prepare('DELETE FROM company_skills WHERE company_id=? AND id=?').run(req.params.companyId,req.params.skillId);res.json({ok:true}); });
  return { router, read, saveRules, saveSkill };
}
module.exports = { installSkills, createCompanySkills, companyInstructions, projectInstructions, formatInstructions, skillInput, skillMarkdown, importMarkdown };
