const assert = require('node:assert/strict');
const { fixture } = require('./member-fixture');

(async () => {
  const f = await fixture({ publicAccess: true, githubRequest: async (_token, path) => {
    if (path === '/user') return { login: 'fixture-owner' };
    if (path.includes('/git/ref/heads/')) return { object: { sha: 'a'.repeat(40) } };
    return { full_name: 'fixture/repository', private: true, permissions: { push: true } };
  } });
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; if (process.env.MANAGEMENT_TEST_VERBOSE) console.log(message); };
  async function rpc(name, args = {}, key = f.token('user_owner'), extra = {}) {
    const response = await fetch(f.base + '/mcp', { method: 'POST', headers: {
      authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    const event = text.split('\n').find(line => line.startsWith('data: '));
    const message = JSON.parse(event ? event.slice(6) : text);
    return { status: response.status, result: message.result, error: message.error };
  }
  async function call(id, parameters = {}, body, options = {}) {
    const r = await rpc('call_api_operation', { operation_id: id, parameters, ...(body === undefined ? {} : { body }), ...options });
    assert.equal(r.status, 200); assert.ok(!r.result.isError, r.result.content[0].text);
    return JSON.parse(r.result.content[0].text).data;
  }
  try {
    const a = await f.project('Owner company', 'Owner project');
    const other = await f.project('Other account', 'Private project', 'user_other');
    const listing = await f.api('/api/management?query=github');
    check(listing.operations.some(row => row.id === 'PUT /api/:kind(companies|projects)/:id/github'), 'GitHub mutation is discoverable');
    check(listing.permission_scopes.length === 6, 'All permission scopes are discoverable');
    let offset = 0, operations = [];
    do { const page = await f.api('/api/management?limit=100&offset=' + offset); operations.push(...page.operations); offset = page.next_offset; } while (offset !== null);
    check(new Set(operations.map(row => row.id)).size === operations.length, 'Pagination does not duplicate operations');
    check(operations.some(row => row.id === 'GET /api/account/ssh') && operations.some(row => row.path.endsWith('/team-chat')), 'Account SSH alias and all-method team chat are discoverable');
    check(!operations.some(row => /\/worker\/|\/webhook|\/sync\//.test(row.path)), 'Infrastructure endpoints are excluded');
    check((await f.request('/api/management', { user: 'user_other' })).status === 403, 'Another account cannot inspect the management catalogue');
    const connection = await f.api('/api/connections', { method: 'POST', body: { name: 'Management fixture', scope: 'mcp' } });
    const key = connection.token;
    assert.ok(key, 'Connection issuance returns its token once');
    const listed = await rpc('list_api_operations', { query: 'memberships' }, key);
    check(!listed.result.isError && JSON.parse(listed.result.content[0].text).total === 2, 'Existing MCP keys discover management');
    const me = await rpc('call_api_operation', { operation_id: 'GET /api/me' }, key);
    check(JSON.parse(me.result.content[0].text).data.workspaceOwner, 'MCP API request uses the verified owner');
    const direct = await fetch(f.base + '/api/boards', { headers: { authorization: 'Bearer ' + key, 'x-boardly-management': 'true' } });
    check(direct.status === 403, 'MCP keys and forged headers cannot directly access REST');
    const hierarchy = await call('GET /api/hierarchy');
    check(!hierarchy.companies.some(row => row.name === 'Other account'), 'Tenant contents stay isolated');
    const injected = await rpc('call_api_operation', { operation_id: 'GET /api/hierarchy' }, key, { 'x-boardly-workspace': 'user_other' });
    check(!JSON.parse(injected.result.content[0].text).data.companies.some(row => row.name === 'Other account'), 'Connection keys cannot select another tenant');
    await call('PATCH /api/company-boards/:id', { id: a.board.id }, { description: 'Managed description' });
    check((await f.api('/api/hierarchy')).boards.find(row => row.id === a.board.id).description === 'Managed description', 'API field updates persist in the UI source');
    await call('PUT /api/account/github', {}, { token: 'fixture-token-for-management-only' });
    await call('PUT /api/:kind(companies|projects)/:id/github', { kind: 'projects', id: a.project.id }, { repository: 'fixture/repository', branch: 'release/verified', credential_source: 'account', allow_agent: true });
    const gh = await call('GET /api/:kind(companies|projects)/:id/github', { kind: 'projects', id: a.project.id });
    check(gh.effective.branch === 'release/verified' && !JSON.stringify(gh).includes('fixture-token'), 'GitHub settings persist and credentials stay hidden');
    const ghTest = await call('POST /api/:kind(companies|projects)/:id/github/test', { kind: 'projects', id: a.project.id }, {});
    check(ghTest.can_push, 'Provider permission checks run through the same API');
    const member = await call('POST /api/:kind(companies|projects)/:id/members', { kind: 'projects', id: a.project.id }, { email: 'member@example.com', role: 'viewer' });
    const members = await call('GET /api/:kind(companies|projects)/:id/members', { kind: 'projects', id: a.project.id });
    const grant = members.members[0];
    await call('PATCH /api/memberships/:id', { id: grant.grant_id }, { role: 'editor', scopes: ['github', 'ssh', 'computers', 'environment', 'payments', 'members'] });
    const permissions = await f.api('/api/projects/' + a.project.id + '/permissions', { user: member.member.user_id, workspace: 'user_owner' });
    check(permissions.role === 'editor' && permissions.scopes.length === 6, 'All member scopes apply through normal member authorization');
    const memberMcp = await rpc('list_api_operations', {}, f.token(member.member.user_id), { 'x-boardly-workspace': 'user_owner' });
    check(memberMcp.status === 403, 'Member grants do not create owner MCP privileges');
    await call('PATCH /api/memberships/:id', { id: grant.grant_id }, { role: 'viewer', scopes: [] });
    check((await f.request('/api/projects/' + a.project.id + '/github', { user: member.member.user_id, workspace: 'user_owner' })).status === 403, 'Revoking a scope takes effect immediately');
    const invalidScope = await rpc('call_api_operation', { operation_id: 'PATCH /api/memberships/:id', parameters: { id: grant.grant_id }, body: { scopes: ['superadmin'], role: 'editor' } });
    check(invalidScope.result.isError, 'Unknown permission scopes are rejected');
    await call('PUT /api/boards/:boardId/environment/:name', { boardId: a.project.id, name: 'APP_TEST_SECRET' }, { value: 'private-value-only-in-fixture' });
    check(!JSON.stringify(await call('GET /api/boards/:boardId/environment', { boardId: a.project.id })).includes('private-value'), 'Environment values remain write-only');
    const folder = await call('POST /api/boards/:boardId/folders', { boardId: a.project.id }, { name: 'Managed files' });
    const uploaded = await call('POST /api/boards/:boardId/files', { boardId: a.project.id }, { folder_id: folder.id }, { file: { field: 'file', name: 'note.txt', content_type: 'text/plain', content_base64: Buffer.from('MCP upload content').toString('base64') } });
    const files = await call('GET /api/boards/:boardId/files', { boardId: a.project.id });
    check(files.files.some(file => file.name === 'note.txt' && file.folder_id === folder.id), 'Multipart uploads use normal project storage and folder checks');
    const downloaded = await call('GET /api/project-files/:id/download', { id: files.files[0].id });
    check((typeof downloaded === 'string' ? downloaded : Buffer.from(downloaded.content, 'base64').toString()) === 'MCP upload content', 'File downloads pass through authorization');
    for (const args of [
      { operation_id: 'GET https://attacker.invalid/' },
      { operation_id: 'POST /api/worker/heartbeat', body: {} },
      { operation_id: 'GET /api/cards/:id', parameters: { id: '../connections' } },
      { operation_id: 'GET /api/cards/:id', parameters: { id: '%2e%2e%2fconnections' } },
      { operation_id: 'GET /api/:kind(companies|projects)/:id/github', parameters: { kind: 'owner', id: 0 } },
    ]) check((await rpc('call_api_operation', args)).result.isError, 'Invalid operation/path rejected');
    await f.api('/api/connections/' + connection.id, { method: 'DELETE' });
    check((await rpc('list_api_operations', {}, key)).status === 401, 'Revoked MCP keys lose all management access');
    console.log(`Management API: ${checks} checks passed; ${operations.length} operations discovered.`);
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
