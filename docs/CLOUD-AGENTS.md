# Persistent cloud agents

The private preview now runs the owner's Codex worker on Hetzner, independently of the desktop. Four different projects can work concurrently; a project's writers remain serialized. Assigned Work continues across model sessions until completed, blocked or cancelled. Idle workers poll for explicitly queued assignments; they do not automatically start the existing backlog. Ask and Plan keep their action tools disabled.

The owner worker uses a private cached Codex sign-in in its own persistent state directory. Customer API runs use each customer's configured funding/key and permissions. API agents can manage the scoped Boardly work and authorized SSH connections, but do not acquire the owner's shell, browser or Codex account. Rate limits, expired sign-in, exhausted funding and missing access remain real blockers. This architecture supports operation around the clock; it is not an uptime or unlimited-compute guarantee.

## Production runtime

Authoritative compose: `hetzner:/opt/boardly-clerk/compose.yml`. Services are `boardly`, `cloud-worker`, `tailnet` and the existing `tunnel`. Main app image: `boardly-cloud:cloud-agents-20260907`; worker image: `boardly-cloud-worker:recovery-20260907`; Tailscale image: `boardly-tailnet:20260907`. Docker restarts these services unless explicitly stopped.

- `cloud-projects/` contains persistent project directories keyed by the existing project UUID. All 140 files from the prior desktop worker were verified by SHA256 after migration, alongside the separate Boardly application worktree.
- `cloud-worker-state/` contains private Codex sessions, configuration and cached authentication. Never publish or attach it to Boardly.
- `cloud-worker-secrets/` contains the worker configuration/token, a separate Boardly MCP token and the private initial Codex authentication seed. The seed is copied only when persistent authentication is absent. Renew the persistent sign-in when required; replacing the seed alone does not replace existing state.
- `tailnet-state/` contains one tsnet node/state directory per signed-in Boardly user. `tailnet-token` authenticates app-to-sidecar calls and must remain private.
- Local `boardly-worker.service` is stopped and disabled. `project-terminals.service` remains enabled for local terminal persistence.

The worker is non-root, has no Linux capabilities or Docker socket, uses a read-only container root, and has bounded memory, CPUs and processes. Docker's outer seccomp/AppArmor profiles are disabled only for this worker so Codex can create its inner bubblewrap sandbox. Codex still enforces workspace-write with its protected paths; live verification allowed a project file write and denied a sibling workspace write. This follows the [official Codex container guidance](https://github.com/openai/codex/blob/main/.devcontainer/README.md). The app and Tailscale sidecar retain their existing outer profiles. Do not use the unsupported legacy Landlock fallback or disable Codex's project sandbox.

## Recovery and blockers

Work returns a structured checkpoint: continue, completed or blocked. Continue starts another session in the same saved conversation. Blocked persists a reason, exact next action and linked task in Blocked; Resume supplies clarification to the same assignment. Queued tasks use To Do, claimed tasks use In Progress, and completed linked tasks use Done Awaiting Revisions.

On worker restart, unfinished cloud Work is reclaimed with a recovery instruction to inspect existing files and external outcomes before repeating actions. The result outbox uses atomic writes; output uploads are idempotent by job, name and content. Disposable input downloads are rebuilt after a crash. A missing remote-operation outcome must be treated as uncertain, never assumed unsuccessful. User cancellation does not automatically resume.

Account API work also recovers through the cloud workspace registry without requiring an open browser. Provider failures become visible blockers. The previous fixed eight-step tool limit has been removed; existing funding and permission checks remain enforced.

## Tailscale and SSH

Account & AI → Tailscale → Connect creates that user's isolated node and supplies the Tailscale sign-in URL. The user must approve its network join. Until status is Running, no device access is claimed. The device chooser only includes peers of that user's node; arbitrary addresses or another account's device identifiers cannot be dialled through the connector. Disconnect closes active sockets and removes that account's node state without affecting other accounts.

Company or Project → SSH lets the user choose a connected Tailscale device, SSH port, trusted host fingerprint and private authentication. Agent permission remains off unless enabled. Credentials stay encrypted in Boardly and the cloud SSH broker rechecks scope/permission for every command. No personal SSH keys were imported during deployment.

## Verification and operation

Full regressions and browser flows passed. Live cloud testing verified actual Codex/MCP/shell execution, multiple sessions, blocker display, same-job Resume, output upload and saved chat with the desktop worker stopped. A second live test restarted the worker during an actual shell command: it automatically resumed the same job, inspected the original checkpoint without rewriting it, and saved its recovery result. Logs/screenshots are in `/home/ben/.local/share/boardly-ops/` under `live-cloud-*`.

Tailscale account isolation, authenticated CONNECT transport, scoped SSH and disconnect behavior passed fixture tests. Production connector sign-in and the live UI were verified; Ben's private network activation still awaits his Tailscale sign-in. Do not report his devices as connected until status is Running and a real network check succeeds.

Check `docker compose -f /opt/boardly-clerk/compose.yml ps`, cloud worker summary logs, and Boardly's fresh heartbeat before reporting availability. Restart only the affected service. Keep all four current SQLite databases, uploads, the encryption key, cloud project files, worker state/secrets and tailnet state in private backups. The pre-upgrade database backup is `data/backups/before-cloud-agents-20260907`; migration rehearsal preserved all 2,718 original rows across 31 tables. This is a rollback snapshot, not a substitute for backing up subsequent writes. The previous compose is `compose.before-cloud-agents-20260907.yml`; rolling back requires explicitly stopping the new worker and preserving current data. Never restore stale desktop data or alter the separate legacy `/opt/boardly` deployment.
