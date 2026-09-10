const express = require('express');
const { accessForMember } = require('./member-access');
const { SCOPE_CATALOG, SCOPE_IDS, validateScopes } = require('./member-permissions');
const fail = (status, message) => Object.assign(Error(message), { status });

function createMemberRoutes({ memberships, identity, origin }) {
  const router = express.Router(), body = express.json({ limit: '8kb' });
  const run = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const access = req => accessForMember(req.tenant.app.db, memberships.grants(req.workspaceOwnerId, req.cloudUserId));
  function requireManagement(req, kind, id) {
    const table = kind === 'company' ? 'companies' : 'boards';
    if (!req.tenant.app.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) throw fail(404, 'Shared resource not found');
    if (req.workspaceIsOwner) return 'editor';
    const current = access(req);
    if (!current.capabilities(kind, id).includes('members')) throw fail(403, 'Member management is not enabled for this scope');
    return kind === 'company' ? current.company(id) : current.project(id);
  }
  function authorizeTarget(req, kind, id, grant, proposedRole) {
    const role = requireManagement(req, kind, id);
    if (req.workspaceIsOwner) return;
    if (grant?.user_id === req.cloudUserId) throw fail(403, 'Only the owner can change your membership');
    if (grant?.scopes.length || grant?.owner_ssh) throw fail(403, 'Only the owner can change a member with extra permission scopes');
    if (role !== 'editor' && (grant?.role === 'editor' || proposedRole === 'editor')) throw fail(403, 'You can manage Viewer access only');
  }
  function target(req) {
    const grant = memberships.grant(req.params.id);
    if (!grant || grant.owner_id !== req.workspaceOwnerId) throw fail(404, 'Membership not found');
    return grant;
  }
  const resource = req => ({ kind: req.params.kind === 'companies' ? 'company' : 'project', id: Number(req.params.id) });
  const describe = (req, row) => {
    let canManage = true;
    try { authorizeTarget(req, row.kind, row.resource_id, memberships.grant(row.grant_id), row.role); }
    catch { canManage = false; }
    const companyId=row.kind==='project'?require('./hierarchy').createHierarchy(req.tenant.app.db).scope(row.resource_id)?.company_id??null:null;
    return { ...row, can_manage: canManage, scopes_need_review:row.kind==='project'&&row.scopes.length>0&&(row.scope_company_id??null)!==companyId };
  };
  router.get('/api/projects/:id/permissions', run((req, res) => {
    const id=Number(req.params.id),current=access(req);
    if(!req.tenant.app.db.prepare('SELECT id FROM boards WHERE id=?').get(id)||(!req.workspaceIsOwner&&!current.project(id)))throw fail(404,'Project not found');
    res.json({owner:req.workspaceIsOwner,role:req.workspaceIsOwner?'editor':current.project(id),scopes:req.workspaceIsOwner?SCOPE_IDS:current.capabilities('project',id)});
  }));
  router.get('/api/:kind(companies|projects)/:id/members', run((req, res) => {
    const { kind, id } = resource(req), role = requireManagement(req, kind, id);
    const direct = memberships.list(req.workspaceOwnerId, kind, id).map(row => describe(req, row));
    let inherited = [], projectMembers = [];
    if (kind === 'project') {
      const scope = require('./hierarchy').createHierarchy(req.tenant.app.db).scope(id);
      if (scope?.company_id) inherited = memberships.list(req.workspaceOwnerId, 'company', scope.company_id).map(row => ({ ...row, can_manage: false, inherited_from: scope.company_name }));
    } else {
      const projects = req.tenant.app.db.prepare('SELECT p.workspace_id,p.name FROM company_projects p JOIN company_boards b ON b.id=p.parent_board_id WHERE b.company_id=?').all(id);
      projectMembers = projects.flatMap(project => memberships.list(req.workspaceOwnerId, 'project', project.workspace_id).map(row => ({ ...describe(req, row), project_name: project.name })));
    }
    res.json({ members: direct, inherited, project_members: projectMembers,
      can_manage_scopes: req.workspaceIsOwner, scope_catalog: SCOPE_CATALOG,
      allowed_roles: role === 'editor' ? ['editor', 'viewer'] : ['viewer'],
      usage: memberships.usage(req.workspaceOwnerId), user_limit: req.accountPlan.users, sign_in_url: origin + '/sign-in' });
  }));
  router.post('/api/:kind(companies|projects)/:id/members', body, run(async (req, res) => {
    const { kind, id } = resource(req), role = req.body?.role || 'editor';
    // Creation never grants advanced scopes. The owner enables them explicitly
    // on the resulting grant so a duplicate Add cannot reset privileges.
    if (req.body?.scopes !== undefined || req.body?.owner_ssh !== undefined) throw fail(400, 'Add the member first, then set their permission scopes');
    authorizeTarget(req, kind, id, null, role);
    const member = await memberships.add({ ownerId: req.workspaceOwnerId, email: req.body?.email,
      kind, resourceId: id, memberRole: role, limit: req.accountPlan.users, identity,
      authorize: (grant,userId) => {if(!req.workspaceIsOwner&&userId===req.cloudUserId)throw fail(403,'Only the owner can change your membership');authorizeTarget(req, kind, id, grant, role);} });
    res.status(201).json({ member, sign_in_url: origin + '/sign-in', message: 'User added. Share the sign-in link with them.' });
  }));
  router.patch('/api/memberships/:id', body, run((req, res) => {
    const grant = target(req), hasOwnerSsh = req.body?.owner_ssh !== undefined, hasScopes = req.body?.scopes !== undefined, hasRole = req.body?.role !== undefined;
    if (!hasScopes && !hasRole && !hasOwnerSsh) throw fail(400, 'Choose a role or permission scopes to update');
    if ((hasScopes || hasOwnerSsh) && !req.workspaceIsOwner) throw fail(403, 'Only the account owner can change member permission scopes');
    if (hasScopes) validateScopes(req.body.scopes);
    memberships.db.transaction(() => {
      authorizeTarget(req, grant.kind, grant.resource_id, target(req), req.body.role);
      if (hasOwnerSsh) memberships.setOwnerSsh(req.workspaceOwnerId, grant.id, req.body.owner_ssh, req.cloudUserId);
      if (hasRole) memberships.update(req.workspaceOwnerId, grant.id, req.body.role);
      if (hasScopes) memberships.setScopes(req.workspaceOwnerId, grant.id, req.body.scopes, req.cloudUserId,grant.kind==='project'?require('./hierarchy').createHierarchy(req.tenant.app.db).scope(grant.resource_id)?.company_id??null:null);
    }).immediate();
    res.json({ ok: true });
  }));
  router.delete('/api/memberships/:id', run((req, res) => {
    memberships.db.transaction(() => {
      const grant = target(req);
      authorizeTarget(req, grant.kind, grant.resource_id, grant);
      memberships.remove(req.workspaceOwnerId, grant.id);
    }).immediate();
    res.json({ ok: true });
  }));
  router.use((error, req, res, next) => error.status ? res.status(error.status).json({ error: error.message }) : next(error));
  return router;
}
module.exports = { createMemberRoutes };
