const { z } = require('zod');
const { internalRequest } = require('./internal-request');
const { SCOPE_CATALOG } = require('./member-permissions');
const fail = (status, message) => Object.assign(Error(message), { status });
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// Runtime infrastructure protocols and provider callbacks are not user settings.
const excluded = /^\/api\/(?:worker|sync|mcp|coach|login|logout|auth-config|management|webhooks?)(?:\/|$)|\/webhook(?:\/|$)/i;

const fieldHints = [
  [/^\/api\/(?:companies|company-boards)(?:\/:id)?$/, ['name', 'description', 'company_id']],
  [/^\/api\/projects(?:\/:id)?$/, ['name', 'description', 'parent_board_id']],
  [/^\/api\/boards(?:\/:id)?$/, ['name', 'description', 'color', 'emoji', 'starred']],
  [/\/github$/, ['repository', 'branch', 'credential_source', 'token', 'allow_agent']],
  [/^\/api\/account\/github$/, ['token']],
  [/\/members$/, ['email', 'role']],
  [/^\/api\/memberships\/:id$/, ['role', 'scopes', 'owner_ssh']],
  [/\/team-chat$/, ['body', 'client_id']],
  [/\/ssh(?:\/:connectionId)?$/, ['label', 'host', 'port', 'username', 'private_key', 'passphrase', 'password', 'fingerprint', 'allow_agent', 'jump_id', 'access', 'tailnet_device_id']],
];

function catalogue(routers) {
  const operations = new Map(), seen = new Set();
  function visit(router) {
    if (!router || seen.has(router)) return;
    seen.add(router);
    for (const layer of router.stack || router._router?.stack || []) {
      if (!layer.route) { visit(layer.handle); continue; }
      const paths = [layer.route.path].flat().flatMap(path => typeof path === 'string' && path.includes('/:kind(companies|projects|owner)/:id/ssh')
        ? [path.replace('companies|projects|owner', 'companies|projects'), path.replace('/:kind(companies|projects|owner)/:id/ssh', '/account/ssh')]
        : [path]);
      for (const path of paths) {
        if (typeof path !== 'string' || !path.startsWith('/api/') || excluded.test(path)) continue;
        const source = layer.route.stack.map(item => String(item.handle)).join('\n');
        const fields = [...source.matchAll(/\breq\.body\??\.([a-zA-Z_][\w]*)/g)].map(match => match[1]);
        const query = [...source.matchAll(/\breq\.query\??\.([a-zA-Z_][\w]*)/g)].map(match => match[1]);
        for (const [pattern, names] of fieldHints) if (pattern.test(path)) fields.push(...names);
        for (const method of METHODS) {
          const teamChatMethod = layer.route.methods._all && path.endsWith('/team-chat') && ['GET', 'POST'].includes(method);
          if (!layer.route.methods[method.toLowerCase()] && !teamChatMethod) continue;
          const id = method + ' ' + path;
          if (operations.has(id)) continue;
          operations.set(id, { id, method, path, parameters: [...path.matchAll(/:([\w]+)/g)].map(match => match[1]),
            body_fields: method === 'GET' ? [] : [...new Set(fields)].sort(), query_fields: [...new Set(query)].sort(),
            mutation: method !== 'GET', multipart: /(?:multer|multipart|upload)/i.test(source) || /\/(files|attachments|transcribe)$/.test(path) && method === 'POST',
            body_policy: 'Pass the endpoint JSON fields. Hints are not an exhaustive schema; the existing API validates fields, limits and permissions.',
            _regexp: layer.regexp,
          });
        }
      }
    }
  }
  routers.forEach(visit);
  return [...operations.values()].sort((a, b) => a.id.localeCompare(b.id));
}
const publicOperation = ({ _regexp, ...operation }) => operation;

function createManagement({ app, parent, origin, routers, authorizeRequest }) {
  const operations = () => catalogue(routers());
  function list(query = '', offset = 0, limit = 50) {
    const matches = operations().filter(operation => (operation.id + ' ' + operation.body_fields.join(' ')).toLowerCase().includes(query.toLowerCase()));
    return { version: 1, owner_only: true, permission_scopes: SCOPE_CATALOG, total: matches.length, offset,
      operations: matches.slice(offset, offset + limit).map(publicOperation), next_offset: offset + limit < matches.length ? offset + limit : null,
      notes: 'Management runs as the authenticated workspace owner. Identifiers, audit timestamps, computed values and provider-owned subscription entitlements are not editable fields. Secret settings retain their existing write-only or masked behavior.' };
  }
  function describe(id) {
    const operation = operations().find(item => item.id === id);
    if (!operation) throw fail(404, 'API operation not found');
    return { ...publicOperation(operation), permission_scopes: /members|permissions/.test(id) ? SCOPE_CATALOG : undefined };
  }
  async function invoke({ operation_id, parameters = {}, query = {}, body, file }) {
    const operation = operations().find(item => item.id === operation_id);
    if (!operation) throw fail(404, 'Choose an operation from list_api_operations');
    let path = operation.path.replace(/:([\w]+)(?:\(([^)]+)\))?/g, (_match, key, pattern) => {
      const value = String(parameters[key] ?? '');
      if (!value || !/^[A-Za-z0-9_@.,-]+$/.test(value) || value === '.' || value === '..' || pattern && !new RegExp('^(?:' + pattern + ')$').test(value)) throw fail(400, 'Invalid path parameter: ' + key);
      return encodeURIComponent(value);
    });
    if (!path.startsWith('/api/') || excluded.test(path) || /[:*?()\\]/.test(path)) throw fail(400, 'Unsupported API path');
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) search.set(key, String(value));
    if (search.size) path += '?' + search;
    const headers = { host: parent.get('host'), origin };
    // No user-supplied identity headers, tokens, origins, URLs or workspace IDs.
    for (const key of ['authorization', 'cookie', 'x-boardly-workspace']) if (parent.headers[key]) headers[key] = parent.headers[key];
    let payload = body;
    if (file) {
      if (!operation.multipart) throw fail(400, 'This operation does not accept a file');
      if (!/^[\w.-]{1,80}$/.test(file.field) || /[\r\n"\\/]/.test(file.name) || !file.name || file.name.length > 250 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.content_type || 'application/octet-stream')) throw fail(400, 'Invalid file metadata');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) throw fail(400, 'Invalid base64 file');
      const data = Buffer.from(file.content_base64, 'base64');
      if (data.length > 2 * 1024 * 1024) throw fail(413, 'MCP uploads are limited to 2 MB; use the app for larger files');
      const boundary = 'boardly-' + require('node:crypto').randomUUID(), parts = [];
      for (const [key, value] of Object.entries(body || {})) {
        if (!/^[\w.-]+$/.test(key)) throw fail(400, 'Invalid form field');
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value ?? ''}\r\n`));
      }
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.content_type || 'application/octet-stream'}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`));
      payload = Buffer.concat(parts); headers['content-type'] = 'multipart/form-data; boundary=' + boundary;
    } else if (body !== undefined) headers['content-type'] = 'application/json';
    const result = await internalRequest(app, { method: operation.method, url: path, headers, body: payload, prepare: authorizeRequest });
    if (result.status >= 400) throw fail(result.status, `API ${result.status}: ${result.data?.error || 'Request failed'}`);
    return result;
  }
  return { list, describe, invoke };
}

function registerManagementTools(server, management) {
  const register = (name, description, inputSchema, callback, readOnlyHint = false) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: !readOnlyHint },
  }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await callback(args), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  register('list_api_operations', 'Discover cloud management operations, editable-field hints and permission scopes. Search by feature (github, ssh, members, computers, payments, files, chat, billing, companies). Pagination includes every exposed app API route.', {
    query: z.string().default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50),
  }, ({ query, offset, limit }) => management.list(query, offset, limit), true);
  register('get_api_operation', 'Inspect an API operation before calling it, including path parameters, body hints and permission scopes.', { operation_id: z.string() }, args => management.describe(args.operation_id), true);
  register('call_api_operation', 'Call a discovered Boardly API operation with the current owner identity. Uses the same permission checks, validation and masked-secret responses as the app. Never retries writes. Purchases, sends, deletions and permission changes require user authorization. File uploads support base64 up to 2 MB.', {
    operation_id: z.string(), parameters: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.record(z.string(), z.unknown()).optional(),
    file: z.object({ field: z.string(), name: z.string(), content_base64: z.string().max(2800000), content_type: z.string().optional() }).optional(),
  }, args => management.invoke(args));
}
module.exports = { createManagement, registerManagementTools, catalogue };
