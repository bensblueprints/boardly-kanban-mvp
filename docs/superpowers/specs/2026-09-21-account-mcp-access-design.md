# Account-scoped MCP access design

## Goal

Every authenticated Boardly account owner can create a revocable MCP connection for their own AI client. MCP requests run as the key owner. A key can operate the owner’s workspace and any shared workspace where that user has explicit member permissions. No user can use another account’s key or bypass workspace/member guards.

## Current root cause

The connection store already records `user_id`, but cloud authorization has an owner-only launch gate. The connector catalog and Account Settings hide MCP from non-platform owners, and the cloud middleware rejects non-owner requests to `/api/connections`, `/mcp`, sync, and account status. The MCP route itself already resolves a tenant from the authenticated connection identity and uses the normal Boardly MCP tools.

## Recommended approach

1. Keep MCP keys account-scoped and bearer-authenticated. Permit only the `mcp` connection scope to call `/mcp` and the management dispatch that MCP explicitly authorizes.
2. Remove the owner check for MCP connection creation/list/revocation and MCP requests. Keep desktop sync and worker connections owner-scoped until their separate customer entitlement model is ready.
3. Resolve MCP workspace selection from the key owner by default, while allowing an explicit `x-boardly-workspace` only for browser/session requests. This prevents a bearer MCP key from silently switching into another tenant while preserving the existing shared-workspace authorization for session users. If a shared workspace must be operated through MCP, issue a key from the user account and use that user’s membership context; the normal member guard remains authoritative.
4. Show Developer & MCP for every account owner. Keep platform-only management discovery separate; MCP users receive normal Boardly tools and permissions, not administrative management tools unless their account is authorized for them.
5. Update help text and provider connector guidance to describe account-scoped MCP setup and connected client authentication.

## Data flow

The user signs into Boardly, opens Account Settings → Developer & MCP, and creates an MCP key. The server stores only the hashed/revocable key metadata and returns the plaintext token once. The user configures the token in Codex, Claude Code, Kimi Code, or another Streamable HTTP MCP client. Each MCP request authenticates the bearer key, derives the user identity from the stored key, loads that user’s tenant, and executes the existing MCP tool with the tenant database and member permission checks.

## Error handling

Expired or revoked keys return 401. A key used with the wrong scope returns 403. A request targeting a workspace where the key owner lacks membership returns 403. The UI should report connection creation/revocation errors without exposing tokens in status responses or logs.

## Verification

Add tests for a non-owner account that creates, lists, revokes, and uses an MCP key; verify a second user cannot use it; verify shared workspace access follows membership permissions; verify sync/worker scopes remain blocked; verify management endpoints remain platform-owner-only; and run the existing MCP, cloud integration, member-scope, settings navigation, and production build checks.
