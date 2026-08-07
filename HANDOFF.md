# Boardly Cloud — handoff

**Branch:** `cloud-sync` (branched from `main` on 2026-08-06)
**Goal:** turn Boardly from a single-tenant self-hosted app into a connected web app at
`boardly.onetimesuite.com`, with registration, and desktop↔cloud sync.

Status at handoff: **foundation built and tested, async conversion not yet started.**
Nothing pre-existing has been modified, so the shipped desktop app is unaffected and
`npm test` is green (13/13).

**Update 2026-08-07 (2):** the container half of #7 and all of #8 are done.
`Dockerfile.cloud` + `docker-compose.cloud.yml` (Postgres 16, healthcheck,
DATA_DIR volume); better-sqlite3 moved to `optionalDependencies` so the cloud
image skips the native build (`npm ci --omit=dev --omit=optional`), desktop
`npm ci` unchanged. **Validated against real Postgres on vmi3218770** (then
torn down completely): store 21/21 (pg variant), accounts 10/10, smoke 13/13
(cloud mode) — plus a live server boot and a `Dockerfile.cloud` image boot via
the compose file, both curl-checked (register/me/CRUD/search/due-filters/
tokens). **Zero dialect bugs found.**

**Update 2026-08-07 (3):** task #6 (scoped) is done — auth + account UI. Cloud mode
gets a login/register screen (`AuthScreen.jsx`) and an account panel
(`AccountPanel.jsx`: user info, logout, API token create/show-once/list/revoke).
Mode gating runs off `/api/me`, which now returns `mode: 'cloud'|'desktop'`; the
desktop path (auto-login, or the self-host password screen) is byte-for-byte the
same components as before. Any 401 in cloud mode drops back to the auth screen via
an `api.onUnauthorized` hook. Devices/sync-status/storage UI deliberately deferred
to task #4 (the sync engine doesn't exist yet).

**Update 2026-08-07 (4):** task #7 deploy is done, with two caveats the next
session must know about:

- **vmi3218770 no longer runs Dokploy** (the server README is stale) — the box
  had only plain Docker, so the deploy is plain `docker compose` + a Caddy
  container for TLS instead of a Dokploy app.
- **The pushed `cloud-sync` branch was missing `server/data/`** — `.gitignore`'s
  `data/` rule (meant for the runtime data dir) also ignored `server/data/`, so
  the data layer never got committed and a fresh clone could not boot
  (`Cannot find module './data/index.js'`). Fixed locally: `.gitignore` now uses
  `/data/` (root-anchored), and the five `server/data/*.js` files show as
  untracked, ready to commit. **Commit and push them before any redeploy** — the
  server's copy at `/root/boardly` had the files tarred in by hand and diverges
  from the branch until then.

Deploy layout on vmi3218770:

- `/root/boardly` — git clone of the repo, branch `cloud-sync`, plus `.env`
  (`POSTGRES_PASSWORD`, `BOARDLY_PORT=5315`).
- Stack: `docker compose -p boardly -f docker-compose.cloud.yml up -d --build`
  → containers `boardly-boardly-1` + `boardly-db-1` (postgres:16-alpine),
  volumes `boardly_boardly-data` (uploads) + `boardly_boardly-pg`.
- TLS: `boardly-caddy` container (caddy:2-alpine, ports 80/443, config
  `/root/boardly-caddy/Caddyfile`, volumes `boardly-caddy-data/-config`)
  reverse-proxies `boardly.onetimesuite.com` → `boardly:5315`. It retries
  Let's Encrypt until DNS points at 147.93.138.155, then serves automatically.
- Redeploy: `cd /root/boardly && git pull && docker compose -p boardly \
  -f docker-compose.cloud.yml up -d --build`.
- Verified live: SPA, register, me, board/list/card, ilike search, token
  create/Bearer/revoke/401, restart persistence. A throwaway account
  `boardly-deploy-check@onetimesuite.com` exists (no delete-account endpoint).
- **DNS is NOT flipped yet** — `boardly.onetimesuite.com` still serves the
  Boardly marketing page through Cloudflare (the app is reachable at
  http://147.93.138.155:5315 until then). See the report for the exact record.

**Update 2026-08-07 (5):** task #5 done — **cloud MCP is live in the codebase**.
The streamable-HTTP endpoint is mounted on the cloud app at `/mcp` (cloud mode
only), stateless per request like `mcp/http.js`, authed by
`Authorization: Bearer <API token>` with the `mcp` scope enforced (403 without
it). `createBoardlyServer({ db, uploadsDir, ownerId })` takes the token user's
id per request; the tools scope every entry-point lookup by the denormalised
`owner_id`, so the desktop stdio/HTTP paths return identical results (the local
user owns everything locally). `test/mcp-cloud.js` (8/8) covers auth, scoping,
scope enforcement and revocation, and passes against real Postgres along with
the other pg suites. **All Phase 1 tasks (#1–#8) are now complete.** The
production stack on vmi3218770 runs pre-sync/pre-MCP code until the parent
commits and redeploys (`git pull && up -d --build` in /root/boardly).

---

## What was asked for

1. Connected web app with a login page at `boardly.onetimesuite.com`.
2. Users can **register** — real multi-tenant accounts, not one shared password.
3. The desktop app **stays in sync** with the web app whenever the user is signed in,
   or via an API token generated on the web and pasted into the desktop app.
4. Agents must be able to publish tasks to the web **without Boardly desktop installed**
   (today the MCP endpoint is `127.0.0.1`-only and writes to the local SQLite, which is
   exactly why the desktop install is currently required).

Decisions taken on these (asked and answered 2026-08-06):

| Question | Decision |
|---|---|
| Sync model | **Local-first two-way sync.** Desktop keeps its own SQLite and works fully offline; changes push/pull when signed in or holding a token. Last-write-wins per record, tombstones for deletes. Chosen because it's the only option that keeps the pay-once promise — the app must never stop working without the server. |
| Hosting | **Coolify on the vmi3218770 dev server**, Docker container, **Postgres** for the cloud DB. |
| Registration | **Open, free for now.** Billing comes later. |
| Attachments | **Not stored in the cloud by default.** Cloud storage is a paid add-on (~$20/mo per TB, pricing still open — see Open questions). Sync moves attachment *metadata*; blobs stay local unless the add-on is active. |

This follows the suite-wide pricing rule (see `onetimesuite-pricing-model`): the software is
pay-once and never crippled; the cloud is the upgrade, and only for genuinely connected data.

---

## Where the code was before

- `server/app.js` (999 lines) — Express + better-sqlite3, **single tenant**. Auth was one
  shared `ADMIN_PASSWORD` with sessions in an in-memory `Set` (`app.js:33-43`). No `users`
  table; nothing in the schema was owner-scoped.
- `electron/main.js` — the desktop app boots that *same* server on a random localhost port
  with its own SQLite under `userData`, and auto-logs-in via a one-shot token.
- `mcp/http.js` — MCP streamable-HTTP on `127.0.0.1:8765`, one bearer token per install,
  writing straight to the local SQLite.

---

## What is built (this session)

All new files under `server/data/`. **No existing file was modified.**

### `server/data/sql.js` — SQL portability
App code writes one dialect; this translates per engine.

- `?` → `$n` for Postgres, with a proper walker so a `?` inside a string literal, quoted
  identifier, or comment is left alone.
- Macros: `{{now}}`, `{{today}}`, `{{now±Nd}}`, `{{ilike}}`, `{{date(x)}}`.
- `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` (inserted *before* any `RETURNING`).

**`{{ilike}}` matters more than it looks.** SQLite's `LIKE` is case-insensitive for ASCII
and Postgres's is not. Without this macro, card search would silently behave differently in
the cloud than on the desktop. Keep the macro list tiny — if a query needs something outside
it, reshape the query rather than growing the list.

### `server/data/sqlite.js` / `pg.js` — the two drivers
One async interface: `all` / `one` / `run` / `exec` / `tx` / `close`.

Two non-obvious decisions:

- **SQLite transactions are serialised through a promise-chain mutex.** better-sqlite3's own
  `db.transaction()` only accepts a *synchronous* function, so it can't wrap an async
  callback. We issue `BEGIN`/`COMMIT`/`ROLLBACK` directly — and without the mutex, an
  `await` inside a transaction would let a second request issue its own `BEGIN` and fail
  with "cannot start a transaction within a transaction". There is a test for five
  concurrent transactions.
- **Postgres `int8` is parsed back to `Number`.** node-postgres returns bigint as a *string*
  to avoid precision loss. Left alone, the API's JSON would change shape between modes
  (`"card_count": "3"` vs `3`) and break arithmetic that works fine on desktop. Boardly's
  ids and counts are nowhere near 2^53.

### `server/data/schema.js` — schema + migrations
- New tables: `users`, `sessions`, `api_tokens`, `devices`, `sync_tombstones`, `sync_state`.
- Every syncable table gains `uid` (UUID), `updated_at`, `rev`.
- Migrations are **additive and idempotent** and backfill UUIDs onto existing rows, so an
  already-installed desktop copy upgrades in place with no user action.
- `ensureLocalUser()` seeds exactly one implicit local user in desktop mode and adopts any
  pre-account boards, so ownership has a single code path instead of `if (multiUser)`
  branches everywhere. **The desktop app must never show a login screen.**

**Why UUIDs:** sync cannot use the integer primary keys. Two devices working offline will
both hand out card id 7 and neither is wrong. Each row's `uid` is generated once, by
whichever device created it, and never changes. `rev` is a monotonic counter used as the
pull cursor.

**Why timestamps are TEXT in both engines:** a `timestamptz` column comes back from Postgres
as a `Date` and serialises as ISO-8601, which would change the API's JSON and break
export/import round-trips and sync comparisons. UTC TEXT in `YYYY-MM-DD HH:MM:SS` also sorts
lexicographically, which the sync cursor relies on.

### `server/data/index.js` — store factory
`DATABASE_URL` present → cloud mode (Postgres, multi-tenant, registration open).
Absent → desktop mode (SQLite in the user's data dir, one local account, no login screen).
Nothing else in the codebase should branch on mode; ask the store.

### Tests
- `npm test` — 13/13, the pre-existing desktop smoke suite, still green.
- `npm run test:store` — 23/23 (`test/store.js`, new; also wired into `test:all`). Covers
  dialect translation, RETURNING, int8-as-number, transactions, rollback, five concurrent
  transactions, idempotent migration, uid backfill.

`test/store.js` runs against Postgres too — `DATABASE_URL=postgres://... node test/store.js`
— and skips the desktop-only assertions when it does. That's the first thing to run on the
server (see gotchas).

---

## What remains, in order

1. ~~**Async conversion**~~ **(done 2026-08-07)** — `server/app.js`, `mcp/tools.js`,
   `server/mailer.js` run on the async store; `createApp` is async and runs migrations
   at startup. `server/coach.js` and `mcp/{settings,http}.js` stay on the sync path,
   gated behind desktop mode. `server/db.js` is unused by the app now (kept for a
   test fallback).

2. ~~**Accounts**~~ **(done 2026-08-07)** — register (cloud-only, open), login/logout/me,
   scrypt with per-user salt (`scrypt:salt:hash`, timing-safe compare), DB-backed
   `sessions` (30-day expiry) replacing the in-memory `Set`. Desktop keeps its
   single-password flow, bound to the implicit local user; no login screen.
   `owner_id` scoping on every route via board-derived joins (`q.*` helpers);
   cross-user access 404s. All writes stamp `uid`/`updated_at`/`rev` (store-wide
   counter in `sync_state`, `nextRev()` helper in app.js and tools.js).

3. ~~**API tokens**~~ **(done 2026-08-07)** — `GET/POST /api/tokens`,
   `DELETE /api/tokens/:id` (cloud-only). Token (48 hex chars) shown once; sha256
   hash at rest; `prefix` identifies it in lists. `resolveUser()` accepts either the
   `sid` cookie or `Authorization: Bearer`, and stamps `last_used_at`. Token `scope`
   is recorded but not yet enforced.

4. ~~**Sync engine**~~ **(done 2026-08-07)** — `server/sync.js` holds the wire format
   and the desktop client; the cloud exposes `POST /api/sync/hello` (device check-in),
   `GET /api/sync/pull?since=N`, `POST /api/sync/push`. Desktop UI: Sync button +
   status dot in the boards header, `SyncPanel.jsx` connect/status/disconnect.
   `test/sync.js` (10/10) runs a real desktop↔cloud conversation and also passes
   against real Postgres.

   Decisions taken (the "unresolved" ones):
   - **LWW tie-break: cloud wins.** Strictly newer `updated_at` wins; an exact
     same-second tie keeps the cloud's row. The clock is second-resolution TEXT,
     so same-second cross-device edits to the same record lose the client's edit.
   - **Tombstones via `AFTER DELETE` triggers** on every syncable table, both
     engines (plpgsql function on pg). The recursive_triggers re-fire hazard
     never materialised: rev stamping lives in app code, not triggers, so the
     only triggers are delete→tombstone inserts and the chain terminates by
     construction (no WHEN guard needed). SQLite gets `recursive_triggers = ON`
     for cascade coverage; verified: deleting a board tombstones the whole subtree.
   - **owner_id is denormalised onto every syncable row** (stamped at insert,
     backfilled by migration). The trigger can then record the owner even after
     the parent rows are gone, and pull needs no join chains.
   - **Desktop rev semantics:** locally-written rows get local revs (≥ 1),
     legacy pre-sync rows sit at 0, cloud-applied rows at -1 — so
     `rev > push_cursor` (from -1) is exactly "written here".
   - Attachment *metadata* syncs; blobs stay local (storage add-on later).
   - Cursors live in `sync_state` (`pull_cursor`/`push_cursor`); devices
     register via `/api/sync/hello`.

5. ~~**Cloud MCP**~~ **(done 2026-08-07)** — mounted at `/mcp` on the cloud app,
   Bearer-token authed (`mcp` scope enforced), tools scoped to the token's user
   via per-request `ownerId`. Agents no longer need the desktop install.

6. **Auth/account UI** — **done 2026-08-07, scoped**: sign in, register, validation
   states, and the account area (user info, logout, API tokens create/show-once/
   list/revoke), motion-designed to the app's standard. Devices, sync status and the
   storage add-on ship with the sync engine (#4).

7. **Deploy** — **done 2026-08-07** (see Update (4) above for layout, caveats and the
   redeploy command). The only open piece is DNS: `boardly.onetimesuite.com` must be
   pointed at 147.93.138.155 in Cloudflare, after which Caddy issues TLS and the app
   is live at https://boardly.onetimesuite.com.

8. ~~**Validate the Postgres path**~~ **(done 2026-08-07)** — ran on vmi3218770 in a
   throwaway dir with uniquely-named `boardly-val-*` containers, torn down after.
   No dialect bugs surfaced. `test/smoke.js` and `test/accounts.js` now follow
   `DATABASE_URL` and run in cloud mode when it's set, so this is repeatable.

---

## Gotchas

- **The Postgres path has never run against real Postgres.** This machine has no Docker and
  no psql, so the pg driver, dialect translation and DDL are verified only by unit-level
  translation tests and by the SQLite path. Dialect bugs (RETURNING, ON CONFLICT, int8
  parsing, TEXT timestamp formatting) cannot surface until it runs on a real server. Run the
  store checks *and* the full smoke suite against Postgres on vmi3218770 before calling the
  deploy good.
- **`main` has uncommitted WIP** — modified `server/app.js`, `server/index.js` and untracked
  `server/mailer.js` (the mail feature). That WIP was carried onto `cloud-sync` and is *not*
  committed. Nothing in this session has been committed at all.
- **This is a shipped, paid product** ($49, installed on customers' machines). The desktop
  path must stay byte-compatible: existing databases upgrade in place, no login screen, no
  behaviour change. The smoke suite is the guardrail — keep it green at every step.
- Desktop mode allows 4GB attachments and cloud defaults to 25MB (`MAX_UPLOAD_MB`); that
  asymmetry is deliberate and interacts with the storage add-on.
- **Cloud semantics are testable without Postgres:** `createApp({ dataDir, mode: 'cloud' })`
  (or `openStore({ mode: 'cloud' })`) forces multi-user mode on the SQLite store — no local
  user seeded, registration open, scoping active. `test/accounts.js` uses this. It verifies
  the account *logic*, not the pg dialect — that still needs a real server.
- **rev/updated_at are stamped in app code** (`nextRev()` against `sync_state`), not by
  triggers. Task #4's tombstone triggers must coexist with that: concurrent `tx()` writers
  on Postgres will serialise on the single `sync_state` row, which is fine at this scale
  but worth knowing before load-testing.

---

## Open questions for Ben

- **Storage pricing.** $20/TB/month is roughly break-even against S3 (~$23/TB), healthy
  against R2 (~$15) or B2 (~$6) — so the number isn't wrong. But per-TB is likely the wrong
  *unit* for a kanban app: attachments are megabytes, so nobody reaches 1TB and the headline
  reads as irrelevant rather than cheap. Suggested instead: a small included allowance
  (5–10GB with the cloud plan) plus $20/TB beyond it.
- Whether cloud accounts should eventually be gated on a Boardly purchase/licence key, or
  stay open with sync as the paid upgrade. Currently open + free.

---

## Running things

```bash
cd "C:/Users/DELL/Desktop/One Time Suite/Web Apps/Boardly/code"
npm test            # desktop smoke suite (13 checks) — the guardrail
npm run test:all    # smoke + store + accounts + mcp + mcp-http + coach
npm start           # server, SQLite, http://localhost:5315
npm run desktop     # Electron
```

Cloud mode is selected purely by `DATABASE_URL`:

```bash
DATABASE_URL=postgres://user:pass@host:5432/boardly npm start
```
