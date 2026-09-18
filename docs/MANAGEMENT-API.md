# Cloud API and MCP management

Cloud MCP 1.2 adds management access to the existing Boardly application API. It retains the current integration-owner restriction; member Viewer/Editor roles and optional scopes do not grant owner MCP access. Local desktop MCP keeps its existing tools.

- `list_api_operations`: search and paginate the live route catalogue. New routes registered by the app appear automatically; the SSH account alias and company team chat are included.
- `get_api_operation`: inspect method, path parameters, body-field hints, upload support and permission scopes.
- `call_api_operation`: invoke an operation using JSON, query parameters or a base64 upload. It reuses the complete cloud middleware and normal app handlers, with the original authenticated identity.
- `GET /api/management?query=github&limit=50&offset=0`: the same catalogue for authenticated API clients.

The catalogue currently covers 159 operations across companies, board containers, projects, cards, checklists, labels, comments, attachments, files/folders, GitHub, SSH, environment settings, payment connections, members, ComputerUse, AI chats, audio, onboarding and account settings. The six member scopes are `computers`, `ssh`, `github`, `environment`, `payments` and `members`; role and legacy `owner_ssh` are managed by the existing membership endpoint. Company-board descriptions are also now available through the existing typed MCP create/update tools.

Body-field names are discovery hints, not a complete JSON Schema. Pass the same supported fields as the app API; its validators remain authoritative. IDs, UUIDs, audit timestamps, computed state and externally managed subscription entitlements remain system-managed. This does not expose raw SQL, worker internals, webhooks, local desktop control or an arbitrary HTTP proxy.

Example: inspect the project GitHub settings:

```json
{"operation_id":"GET /api/:kind(companies|projects)/:id/github","parameters":{"kind":"projects","id":2}}
```

Update a member's allowed scopes (with the owner's authorization):

```json
{"operation_id":"PATCH /api/memberships/:id","parameters":{"id":"THE_GRANT_ID"},"body":{"role":"editor","scopes":["github","ssh"]}}
```

Path values cannot contain URL separators or traversal sequences. Callers cannot provide headers, a destination origin, authentication or an alternate workspace identity. A private, in-process request marker allows an authenticated MCP key to call discovered app routes; the same key remains rejected when used directly on REST endpoints. Authentication and revocation are checked again for every dispatch. Responses retain the app's existing secret masking; new credentials returned once by connection issuance should be handled as secrets.

Writes are never retried automatically. After a timeout, inspect saved state before retrying. Uploads are bounded to 2 MB, responses to 4 MB; use the app for larger transfers. Downloads return text or an explicitly labelled base64 object. Purchases, outgoing messages, deletions and permission changes still require user authorization for the action being performed.

Run `node test/management-api.js` for real HTTP/MCP checks with isolated fixture accounts and locally signed test Clerk JWTs. Tests cover catalogue pagination, actual field updates, GitHub permission checks, all six member scopes, immediate revocation, tenant isolation, write-only environment values, multipart uploads/downloads, path rejection and revoked MCP keys.

SSH stdio clients must forward to the cloud HTTP endpoint to receive these tools. `mcp/cloud-stdio-proxy.cjs` runs inside the cloud container and bridges JSON-RPC lines to the authenticated loopback endpoint. Its first stdin line is the existing MCP key, sent privately through SSH; later lines are ordinary MCP requests. It never prints the key. Do not run the legacy local database server against a cloud workspace. Ben's installed cloud MCP wrapper was upgraded and verified to discover 44 tools, including all three management tools.
