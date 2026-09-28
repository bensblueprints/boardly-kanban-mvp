# Boardly cloud

This branch adds a Clerk-authenticated web deployment while preserving the existing local/password deployment. The initial launch admits only Ben's configured Clerk user ID. Changing the launch gate later admits only users with one of the configured **personal** Clerk Billing plans. Checkout, prices and public registration are not enabled by this code.

## Current implementation

- `npm run start:cloud` starts Express with Clerk's official session middleware. The React app discovers its authentication mode from `/api/auth-config` and loads Clerk only for cloud mode.
- The server checks the verified Clerk subject on every data request. An email address, request header, body, local password or user-editable metadata cannot grant owner access.
- Each account has its own SQLite database and uploads under `CLOUD_DATA_DIR/workspaces/<sha256 of Clerk user ID>/`. Workspace identity is never accepted from query strings or request bodies. Numeric IDs can overlap across databases without crossing accounts.
- `BOARDLY_OWNER_ONLY` defaults to `true`. Setting it to `false` also requires `BOARDLY_PAID_PLAN_SLUGS`. The server checks `auth.has({ plan: 'u:<slug>' })` against verified Clerk session claims. Subscription changes take effect as Clerk refreshes those claims; already issued sessions retain their claim lifetime.
- Uploads require authentication and are served privately as downloads with a sandbox policy. Shared/password login and desktop auto-login cannot authenticate a cloud request. Writes check their origin; session bearer tokens support non-browser requests.
- Card descriptions retain Markdown formatting but pass through DOMPurify before rendering, including descriptions from imported boards.
- The workspace cache keeps at most 32 open databases and evicts inactive instances. Run one application replica per data volume. This launch is intended for one owner and a later small customer rollout; horizontal scaling needs a deliberate storage redesign.
- Host-level MCP controls, desktop sync and the locally configured voice coach are disabled in cloud mode. They remain available in the existing local app. A customer-facing cloud MCP/OAuth integration needs its own implementation before that feature can be sold.

## Clerk setup

1. Use the Boardly Clerk application and the initial domain `boardly.onetimesuite.com`. Configure its production instance and complete Clerk's DNS requirements. Under **User & authentication → Phone**, disable phone signup and any required phone-number collection. Signup must not require a phone number or SMS verification; use email verification or GitHub instead. Keep mandatory SMS MFA disabled. Apply these settings separately to development and production, and verify them in the live environment before onboarding Ben. Create Ben's account and obtain its `user_...` ID.
2. Keep registration restricted in Clerk for the owner-only launch. The server-side owner check remains mandatory even if the Clerk dashboard is accidentally opened to signups.
3. Copy `.env.cloud.example` to `.env.cloud`, set mode `0600`, and fill in the Clerk publishable key, secret key, Ben's Clerk user ID and `BOARDLY_ORIGIN` (for example `https://boardly.example.com`, without a trailing slash).
4. Keep `BOARDLY_OWNER_ONLY=true`. Configure the same origin and sign-in return URL in Clerk. The server passes the exact origin as `authorizedParties`.
5. Never put the Clerk secret key in a `VITE_` setting, frontend source, board/card, image layer or source control. Only the publishable key is returned to the browser.

The supplied production keys are verified and stored only in `/home/ben/.config/boardly-service/cloud.env` (0600); development settings are preserved separately in `cloud.development.env`. The selected origin is `https://boardly.onetimesuite.com`, and both Hetzner SSH and Cloudflare access for this zone are verified. All five Clerk-provided DNS-only CNAMEs have been added. Production is a separate user pool: Ben's account was created with the username from his verified development profile and a reserved email identifier, without copying a password or bypassing email verification. Its exact production user ID is configured as owner. Clerk certificates are deployed and DNS, SSL and mail status are complete. Ben confirmed successful production sign-in on 2026-09-07.

Production settings were verified through the authenticated Clerk CLI: phone signup, phone verification and SMS MFA are disabled, while email-code sign-in is enabled. The initial launch uses email; Facebook, GitHub and Google had no production credentials and are disabled until those connections are configured. New signup is restricted, in addition to the server-side owner-ID gate. The existing owner can sign in with his email address. Synthetic signed-token tests verify the code path; they do not replace a real Clerk sign-in after deployment.

An existing Boardly 1.8.0 deployment was discovered on Hetzner at `/opt/boardly`, with containers `boardly-boardly-1` and `boardly-db-1` (PostgreSQL). Preserve its data, routes and existing sync/account functionality; this new SQLite cloud package must not overwrite that deployment or its volume. The public `boardly.onetimesuite.com` address now routes to the new Clerk app. The older `boardly-api.onetimesuite.com` route and existing deployment remain unchanged.

The new isolated deployment is running at `/opt/boardly-clerk`, using host loopback port 5317 and a dedicated Cloudflare Tunnel. The app is healthy, its private APIs reject anonymous access, and the tunnel is ready. The main hostname is routed to this dedicated tunnel and its public auth configuration returns Clerk owner-only mode over HTTPS. A machine-authenticated owner MCP connection is verified through the local `boardly-cloud-mcp-server` wrapper, which uses Ben's existing SSH authentication and resolves the workspace only from the server's configured owner ID. `boardly-mcp`, `boardly-cloud-mcp` and native Codex now invoke its tools against the migrated owner workspace. This is an owner operations connection, not a customer-facing OAuth/MCP product. All three boards and their IDs/history were preserved and verified through cloud MCP before switching global configuration. The local browser shortcut redirects to the cloud; the old database is a preserved rollback copy.

Clerk CLI 3.3.0 is authenticated and linked to the existing Boardly application. Its Platform API reports DNS, mail and SSL `complete`; there are no pending DNS records or certificate requirements. Use `npx -y clerk deploy status --mode agent` from this worktree to inspect progress. The 20 official Clerk skills are installed under `/home/ben/.agents/skills`.

## Deployment on a VPS

The current app requires Node and a native SQLite module plus persistent disk. The Sites Workers runtime cannot directly execute this Node/native-database architecture; use a VPS/container host for this version rather than publishing only the frontend.

```sh
docker compose -f docker-compose.cloud.yml build
docker compose -f docker-compose.cloud.yml up -d
```

The container runs as the unprivileged `node` user, stores data in the named `boardly-cloud-data` volume, and publishes only to host loopback port 5317. Put the existing HTTPS reverse proxy in front of that port. For a host-level Caddy installation, the site block is:

```caddyfile
boardly.example.com {
    reverse_proxy 127.0.0.1:5317
}
```

Replace the example domain with the chosen hostname and point its DNS at the server before launch. If the proxy runs in a container/Coolify network, route it to the Boardly container on the private container network instead of using its own loopback address. Do not expose the unproxied HTTP port publicly. Configure the proxy's forwarded host/protocol handling to match the canonical origin; do not trust arbitrary forwarded headers from the internet.

Back up the persistent volume regularly and test restoring it. A SQLite backup must use the backup API or a stopped service, not a raw copy of an actively written WAL database. A database snapshot and its uploads should be taken together during a brief write pause.

## Moving Ben's existing boards

The migration completed on 2026-09-07. The authoritative data is on Hetzner under `/opt/boardly-clerk/data/workspaces/<sha256 of production owner ID>`. A consistent backup preserved 3 boards, 8 cards, 9 checklists, 51 checklist items, 41 comments and all IDs/history; no attachments existed. The local source `/home/ben/.config/boardly/data` is preserved for rollback. Current operations and the backup manifest are documented in `/home/ben/.local/share/boardly-ops/CLOUD.md`. The following procedure applies to future migrations:

1. Set up Clerk and record Ben's exact user ID; prepare the destination workspace path with `workspacePath()` from `server/cloud.js`.
2. For a cutover, pause writes from the local web app, native/stdio MCP clients and desktop app; record the cutover time. Take a fresh consistent database backup and uploads copy. Preserve the source backup and local installation.
3. Restore the **database and uploads only** into Ben's empty destination workspace on the cloud volume. Keep local service credentials, MCP tokens and coach configuration off the cloud host. Set ownership to the container's `node` user. Do not overwrite an already populated cloud workspace without reconciling it first.
4. Start cloud Boardly, sign in through the real Clerk application as Ben, and compare boards, cards, checklists and attachments with the source. Test an unapproved account and an anonymous attachment request.
5. Choose the authoritative store before resuming writes. An MCP connection pointing at the source will not automatically write to a remote cloud copy. Keep the local store authoritative until cloud MCP/data access is connected and verified, or complete that integration as part of the final cutover. Avoid two independently writable copies presented as synchronized.

The supported board JSON export/import flow is an alternative for selective moves, but it changes numeric IDs and does not preserve all history. Use the full consistent backup when preserving the current Boardly workflow's IDs/history is required.

## Future paid launch

Agree plan names, prices and included features, configure personal plans/payment collection in Clerk Billing, and add a real customer checkout/account flow. Supply the chosen plan slugs in `BOARDLY_PAID_PLAN_SLUGS`. Test successful payment, expired/cancelled entitlements, account isolation, backup/restore and any plan-specific limits before setting `BOARDLY_OWNER_ONLY=false`. Current code gates workspace access by subscription; no unrequested quotas or prices have been invented.

## Validation

```sh
npm run build
npm run test:all
npm audit --omit=dev
```

`test/cloud.js` signs short-lived local RSA JWTs and runs the actual Clerk middleware. It checks signature tampering, expired tokens, the origin allowlist, owner-only access, personal paid-plan access, entitlement removal, tenant isolation for data/exports/uploads, request-ID spoofing and restart persistence. It never contacts a real Clerk account and uses temporary databases.

References: [Clerk Express middleware](https://clerk.com/docs/reference/express/clerk-middleware), [Clerk React SDK](https://clerk.com/docs/reference/react/overview), [Clerk production setup](https://clerk.com/docs/guides/development/deployment/production).

## Project workspaces and the owner agent

Projects have **Chat with Codex**, **Files**, **Links** and **Environment** controls. A task's **Chat about this task** opens its own saved conversation; it shares its project's working directory, uploaded files and variables. Opening chat does not start work until a message is sent. **Deploy agent** queues work immediately. The cloud stores threads, messages, task bindings, queue state and Codex session IDs in the authenticated account's SQLite database. One run per account is claimed at a time. Stop requests, failed runs and disconnected workers are shown in chat; queued work waits while the computer is offline.

`scripts/codex-worker.cjs <private-settings.json>` is an owner-operated outbound worker. Settings contain `origin`, a worker-scoped `token`, `workspaceRoot`, and optionally a `projects` map from board UUID to an existing absolute project path. Unmapped projects get a persistent UUID directory below `workspaceRoot`. The worker reuses the installed Codex login on this computer; no Codex login file is copied to the cloud. Runs use the workspace-write sandbox and the existing model configuration. `codex exec` saves a session and `resume` continues it. A computer running the worker must remain on and connected for queued messages to execute.

Project uploads are downloaded through active-job-scoped endpoints into a private per-run input directory. The prompt supplies file paths, saved links, project/task context and variable names. Regular output files explicitly placed in the supplied output directory are uploaded to the same project's Files section, up to 100 MB per output. Inputs are removed when the run finishes; generated files and the working directory remain on the connected computer. External file links are retained as links, not downloaded automatically. Project files, chat and environment settings are currently cloud features; desktop synchronization covers boards, cards, checklists and card attachments.

Variables are encrypted with AES-256-GCM, authenticated to the account, board and variable name. The server creates `CLOUD_DATA_DIR/project-secrets.key` (0600). Back up that key securely with the private deployment configuration; losing it makes stored variable values unrecoverable. Normal APIs return names and update timestamps only; values are supplied only when an authorized worker claims that project's run. Variable values are passed in process memory/environment, never written to a generated `.env` file or prompt. System/agent configuration names are reserved. Known values and common encodings are redacted from saved chat/progress, and outputs containing known values are withheld. This protects normal product flows; an owner-authorized program given a secret can still use that secret, and redaction is not a security boundary against malicious code.

Worker tokens are issued using the server's `createConnections(...).issue(ownerId, name, 'worker')` administrative helper and expire after 90 days. Keep worker settings mode 0600 and rotate before expiry. The public key-creation API cannot issue worker credentials. The service should run as Ben, with a private working root, and restart after process failure. Its only inbound interaction is with the local Codex process; all cloud communication is outbound HTTPS.

Verification includes real Clerk middleware tests for account isolation, project/task binding tests, secret-at-rest and redaction checks, file download/output ownership checks, restart persistence, and a browser-driven actual Codex run plus resume. See [official Codex non-interactive execution documentation](https://learn.chatgpt.com/docs/non-interactive-mode).


## Live Codex activity and HTTPS MCP — 2026-09-07

Project/task chat records public progress messages, safe command operation labels, MCP tool names with project/task IDs, file-change paths and task plans. Raw shell arguments, tool output and private reasoning are excluded. Known project secrets and recognizable credentials are redacted before storage. Activities are updated by stable event ID, so a heartbeat does not invent progress. Each run retains up to 200 activity entries; the chat response displays the latest 100 for each of the last 20 runs. Earlier messages remain available.

The worker reports every two seconds. The chat displays elapsed time, last worker contact and last actual activity separately; queued work shows its position. A missing heartbeat becomes a visible waiting state, and the existing two-minute lease marks a lost worker interrupted. Completed/cancelled/failed run history remains attached to the original user request.

Native Codex MCP now connects directly to `https://boardly.onetimesuite.com/mcp`. The supplied key is in `/home/ben/.config/boardly-mcp/token` (0600, parent 0700). `/home/ben/.local/bin/boardly-mcp-headers` emits authorization headers only to Codex's `http_headers_helper` subprocess interface; never invoke it into visible logs. Both `boardly-mcp` and `boardly-cloud-mcp` use this authenticated HTTPS transport immediately. Native tools in an already-open conversation may need a new Codex session to reload transport settings. The former SSH stdio helper is preserved for deliberate recovery, and the stale local database remains unused.

Activity source archive: `/home/ben/.local/share/boardly-ops/boardly-activity-source-20260907.tar.gz`. Deployment source: `/opt/boardly-clerk/activity-upgrade-source`; image `boardly-cloud:activity-20260907`; build log `/opt/boardly-clerk/activity-build.log`. Pre-upgrade consistent owner database/uploads backup: `/opt/boardly-clerk/data/backups/before-live-activity-20260907`. Preserve subsequent cloud writes before rollback. The schema change adds `chat_activity` and nullable `chat_jobs.started_at`; the previous application image can still use the current database.


Final activity verification passed against production: the signed-in browser submitted a request to the real Linux worker, observed native `boardly.list_boards`, `boardly.get_board` and `boardly.get_card` plus a directory check during execution, and restored the saved timeline after reload. The temporary QA session was signed out afterward. Screenshots: `live-codex-activity.png` and `live-project-chat.png` in the local operations directory. Full test suite and build passed; actual isolated agent tests also verified uploaded inputs, secret handling, output uploads and session resume.

The worker was restarted only after existing production jobs finished. Its local activity parser additionally recognizes `boardly-mcp` shell helper calls by tool name. Final combined source snapshot, including that worker refinement and operations notes: `/home/ben/.local/share/boardly-ops/boardly-activity-final-source-20260907.tar.gz`. The server image remains `boardly-cloud:activity-20260907`; the classifier refinement executes in the local worker and requires no cloud server change.


## Project card wallet — 2026-09-07

Ben clarified that he wants to save existing card numbers for website checkout, without connecting a virtual-card provider. The Payments tab stores card number, cardholder name and billing address encrypted with AES-256-GCM under the existing private project key. Authenticated UI responses show masked metadata; a separate billing endpoint returns name/address without the number. Security codes, PINs and track data are not accepted. Card data is omitted from board exports, sync and normal chat/worker context. Each project's cards have pause/remove controls and share a currency-specific lifetime application budget. Agent access is off by default and is explicitly enabled through project payment settings.

The budget is Boardly accounting, not an issuer-enforced card limit. It checks requested final totals atomically, reserves funds before revealing card details to the scoped checkout process, and uses idempotency keys to prevent duplicate reservations. It cannot prevent external purchases, dishonest/mistaken amount reporting, later merchant adjustments or reuse of a card already provided to a checkout script. Paid amounts come from the agent/user, not a bank feed. Unknown outcomes retain a hold and require owner review; actual overcharges are recorded rather than hidden. No automatic refund or credit assumption is made.

The persistent worker hosts a private per-run Unix socket (`BOARDLY_CARD_SOCKET`) and retains the cloud worker credential itself. `scripts/project-card-client.cjs` exposes `fillCheckout`, `withCardForCheckout` and `finishCheckout`. Raw numbers are available only inside the checkout callback; public return values are masked. `fillCheckout` verifies the merchant origin and any explicitly inspected iframe origin before filling Playwright fields. It does not submit orders. The agent must follow the user's actual purchase instruction, include tax/shipping in the total, report a confirmed outcome, and stop for missing security codes or bank verification. Never print, persist, screenshot or return card objects in checkout scripts. Boardly redacts recognized PANs in chat/activity and filters known secrets in project outputs; these controls are not a substitute for keeping raw credentials out of execution output.

New tables: `project_payment_settings`, `project_payment_cards`, `project_purchases`. The key remains `/opt/boardly-clerk/data/project-secrets.key`; preserve its existing private backup. Keep current cloud data on rollback. Source archive: `/home/ben/.local/share/boardly-ops/boardly-payments-source-20260907.tar.gz`. Image: `boardly-cloud:payments-20260907`; remote source `/opt/boardly-clerk/payments-upgrade-source`; build log `/opt/boardly-clerk/payments-build.log`; pre-deploy data backup `/opt/boardly-clerk/data/backups/before-card-wallet-20260907`.

Validation: full test suite and build; `test/project-payments.js` covers encrypted storage, masked APIs, cross-account/project access, concurrent reservations, idempotency, paused access, stale checkout outcomes, restart and actual overcharge reporting. The real Codex worker and browser test `qa-project-payments.cjs` used only a synthetic card and an intercepted local checkout page, filled number/name/expiry/address data without putting card numbers in Boardly chat/activity, released the no-charge reservation, and restored the history after reload. Screenshots: `qa-payment-wallet.png` and `qa-payment-history.png`. No live purchase was made.


Production wallet verification passed after deployment: signed in as the configured owner, opened Payments, saved a synthetic card, confirmed masked metadata and private billing after browser reload, then removed only the test card. No budget/access settings were changed and no real purchase was made. The temporary Clerk session was signed out and its ticket deleted. Screenshot: `/home/ben/.local/share/boardly-ops/live-project-payments.png`. The updated worker was restarted while no production job was running. The live container reports healthy with zero restarts. Previous compose: `/opt/boardly-clerk/compose.before-payments-20260907.yml`.

## Companies, boards, projects and company email

Cloud navigation is Company → Board → Project → Tasks. Existing `boards` rows remain project workspaces with stable IDs and UUIDs; `companies`, `company_boards` and `company_projects` add organization without moving task, chat, file, environment or payment records. Each existing workspace appears as a General project within a same-named board, initially Unassigned. Deleting a company unassigns its boards and removes only its mailbox connections. A board must be empty before deletion. Moving a board carries all its projects; moving a project preserves its workspace identity and secrets.

`GET /api/hierarchy`, `/api/companies`, `/api/company-boards` and `/api/projects` manage the hierarchy. Existing `/api/boards/:id` and MCP `list_boards`/`get_board` retain their workspace IDs for compatibility and include hierarchy metadata. MCP `get_hierarchy`, `create_company`, `update_company`, `create_company_board`, `update_company_board`, `create_project` and `update_project` expose the new organization. Hierarchy metadata is managed in the cloud workspace; released desktop clients continue syncing the existing flat project/task tables. Company credentials and inbox messages are not synced or included in project exports.

Company Emails supports multiple public IMAP mailboxes over implicit TLS (normally port 993), using provider app passwords. Each connection has a label, address, host, username, connection test and explicit agent-access toggle (off by default). This is IMAP/app-password access; an email address by itself is not an authenticated connection, and OAuth-only providers require another connection method. Passwords use AES-256-GCM with the existing private project key and company/account/mailbox-specific AAD. Back up the key separately from databases. Metadata endpoints never return credentials. Inbox previews use text only and do not load HTML or attachments. All mailbox operations acquire a read-only IMAP lock, fetch at most 50 recent messages, cap source messages at 500 KB, verify TLS and reject private-network mail targets. There is no send/delete/mark-read or unattended inbox watcher.

The worker receives enabled mailbox metadata for its project's company. Credentials stay on the cloud server; a private per-run `BOARDLY_EMAIL_SOCKET` brokers list/read/code requests for that active job. Company scope is captured at claim time and checked before and after each mailbox operation, together with active job status and current mailbox access. The `scripts/company-email-client.cjs` helper exports `listMessages`, `readMessage`, `withVerificationCode` and `fillVerificationCode`. Code retrieval requires an exact sender, subject filter and sign-in request timestamp within 15 minutes, selects the latest matching message and requires one clear numeric code. Filling verifies the inspected HTTPS page origin and does not submit forms. Codes stay inside the fill callback, are redacted from chat/activity and are not stored in Boardly. Email content is untrusted data, not agent instructions. General email reading may contain private text; agents should disclose only what the user requested.

Validation: `test/company-email.js` covers migration, hierarchy CRUD/moves, encryption, tenant/company/worker separation, disabled access, in-flight scope changes, stale/ambiguous code handling, helper-origin checking and persistence. `test/company-imap.js` exercises actual ImapFlow TLS authentication, EXAMINE, UID fetches and MIME decoding against an ephemeral local IMAP server. The operations browser test `qa-company-workspace.cjs` additionally verifies the full UI and a real Codex task run filling a synthetic verification code into a local intercepted browser form. No real company mailbox was connected during these tests.
