const assert = require('node:assert/strict');
const { fixture } = require('./member-fixture');

(async () => {
  const f = await fixture({ publicAccess: true });
  try {
    const shared = await f.project('Clothing Company', 'Nasdo');
    const privateProject = await f.project('Private company', 'Private project');
    f.users.push({ id: 'user_existing', emailAddresses: [{ emailAddress: 'existing@example.com', verification: { status: 'verified' } }] });
    await f.project('Personal company', 'Personal project', 'user_existing');
    const me = workspace => f.api('/api/me', { user: 'user_existing', workspace });
    assert.equal((await me()).workspaces.length, 1);
    await f.api(`/api/companies/${shared.company.id}/members`, { method: 'POST', body: { email: 'existing@example.com', role: 'editor' } });
    let access = await me();
    assert.equal(access.workspaceOwner, true, 'Personal work is not silently switched');
    const companies = access.workspaces.find(w => w.owner_id === 'user_owner').companies;
    assert.deepEqual(companies.map(c => c.name), ['Clothing Company']);
    assert.equal(companies[0].role, 'editor');
    assert.equal(companies[0].project_count, 1);
    assert.ok(!JSON.stringify(access).includes('Private company'));
    const tree = await f.api('/api/hierarchy', { user: 'user_existing', workspace: 'user_owner' });
    assert.deepEqual(tree.companies.map(c => c.name), ['Clothing Company']);
    assert.equal((await f.request(`/api/boards/${privateProject.project.id}`, { user: 'user_existing', workspace: 'user_owner' })).status, 404);
    const companyMembers = await f.api(`/api/companies/${shared.company.id}/members`);
    await f.api(`/api/memberships/${companyMembers.members[0].grant_id}`, { method: 'DELETE' });
    access = await me('user_owner');
    assert.equal(access.workspaceId, 'user_existing');
    assert.equal(access.workspaces.length, 1, 'Revoked company disappears immediately');
    // A project grant still exposes its parent company as navigation, without
    // granting access to siblings or treating the guest as a company editor.
    await f.api(`/api/projects/${shared.project.id}/members`, { method: 'POST', body: { email: 'existing@example.com', role: 'viewer' } });
    access = await me();
    assert.equal(access.workspaces.find(w => !w.owner).companies[0].role, 'project_guest');
    assert.equal((await f.api(`/api/boards/${shared.project.id}`, { user: 'user_existing', workspace: 'user_owner' })).permissions.role, 'viewer');
    assert.equal((await f.api('/api/me', { user: 'user_unrelated' })).workspaces.length, 1);
    assert.equal((await f.request('/api/hierarchy', { user: 'user_unrelated', workspace: 'user_owner' })).status, 403);
    console.log('PASS: shared company discovery from personal account, live grants/revocation, project guests, private-name isolation and tenant boundaries');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
