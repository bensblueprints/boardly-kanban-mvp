# Continuous project work

Boardly Work jobs have no overall time or turn limit. Completed work, explicit Stop,
revoked access, a real dependency, and exhausted funding without an enabled fallback
are stopping conditions. Ask and Plan remain single replies.

## Project employees

Open a project's chat and choose **Employees**. Every project has Morgan
(Manager), Alex (Engineer), Sam (Designer), and Casey (Reviewer). **Call an
employee** assigns an existing task by number with your instructions. Choose
Morgan to have a manager break the task into specialist assignments and review
the combined result. You can also call a specialist directly.

Morgan uses `employee_delegate` to create a linked subtask and saved employee
conversation. Delegations inherit the requesting member's current permissions;
foreign-project employees and recursive manager spawning are rejected. A stable
request key prevents duplicate assignments after retries or restart. Morgan can
call each of the three specialists concurrently for independent work, then use
`employee_wait` to release its worker slot until they report. This works even with
one available slot. Results survive restart, and Morgan resumes to review them.
An unfinished child cannot silently become a completed parent task. Stopping a
manager cancels its running and queued children; already produced work is retained.
The manager must assign separate file ownership or sequence shared edits.

**Enable continuous team** authorizes Morgan to manage that project's unclaimed
To Do tasks. The dispatcher checks every 15 seconds, skips blocked or previously
assigned tasks, and shares completion/blocker handoffs. Employees can read and post
project team messages; those messages do not grant additional permissions. Pausing
the team stops new parent assignments; existing managers can finish their assigned
work and call the specialists it requires. Stop cancels an existing assignment.
Owners control continuous dispatch; editors may call employees within their project.

Returning to a project restores the conversation you selected, including task chats
and older threads. The selection survives refresh in the current browser tab and
is isolated by user and workspace. An explicit conversation link takes priority;
closing chat keeps it closed on the next project visit. Only navigation metadata
is stored in browser session storage.

Existing projects receive rosters automatically. Continuous dispatch starts paused
to preserve existing backlog and dependencies. Existing requested Work jobs still
run without enabling continuous dispatch.

## Concurrency and recovery

Set `BOARDLY_MAX_AGENTS` consistently in the app, cloud worker and ChatGPT connector.
Supported range: 1–32; default 4. The September 15 deployment uses 16. This is a
capacity ceiling, not a promise that a provider or a single GPU can execute 16 jobs
at once. Separate projects and separate hosted task conversations can overlap.
Native writers sharing a project workspace and messages in the same conversation
remain ordered. GitHub commits still compare the current branch SHA before writing.

The ChatGPT connector uses one Codex app-server authentication manager per account
with concurrent ephemeral threads. A stalled individual response times out after
30 minutes; persistent Work retries transient failures with backoff up to 60 seconds.
Public tool calls/results checkpoint in SQLite. On restart, the worker reconciles
operations whose result was not confirmed before considering another mutation.
Private reasoning, provider metadata, and screenshot images are excluded from these
checkpoints. Native Work retains its Codex session when reconnecting.

Invalid replacement ComputerUse credentials no longer erase working credentials or
desktop assignments. Expired leases must be reacquired. Human takeover still pauses
control. Browser API calls refresh an expired Clerk token once after a 401.
Revoked OpenAI/Clerk credentials still require their provider's sign-in flow.

## Local AI fallback

In Account & AI, connect **Local AI** through a selected Tailscale device and enable
**Use Local AI if paid allowance runs out**. Confirm the model supports tool calls.
Allowance exhaustion moves that Work run to Local AI; the primary provider selection
stays unchanged. Each run's fallback selection persists through app restart.
Rate limiting retries the primary provider; authentication failures require sign-in.
Turning fallback off or removing the connection stops subsequent fallback calls.

The Mac installer creates `com.boardly.local-ai`, a separate Ollama model directory
and tailnet listener. It does not modify the desktop Ollama app's existing models.
The installed Mac uses Qwen3.5 4B. A small local model has lower task quality and
context capacity than the primary model; it still uses the same project permission
checks. Its machine must be awake and reachable. No cloud fallback is enabled inside
the local Ollama service.

## Durable local GPU generation

Install `scripts/gpu-queue.py` as `~/.local/bin/boardly-gpu-queue` and install
`deploy/boardly-gpu-queue.service` as a user systemd unit. Install a persistent
ComfyUI service too; `deploy/comfyui-persistent.service` is the 5060 Ti example.
Enable user lingering so those services run without an open terminal.

Through an already enabled project SSH connection, submit a validated ComfyUI API
workflow (models and input files must exist on that GPU machine):

```sh
~/.local/bin/boardly-gpu-queue submit --id STABLE-UUID --workflow /path/workflow.json
~/.local/bin/boardly-gpu-queue status --id STABLE-UUID
```

Record the UUID and output paths on the task. Workflows persist in
`~/.local/share/boardly-gpu/queue.db` before submission. The queue uses a stable
ComfyUI prompt ID, serializes GPU submissions, waits behind other ComfyUI jobs, and
recovers a lost submission response by checking queue/history. It runs independently
of chat, paid text allowance and terminal sessions.

If ComfyUI loses both a submitted job and its history during a machine restart,
the queue marks it blocked for output inspection rather than generating duplicate
deliverables. After resolving that specific outcome:

```sh
~/.local/bin/boardly-gpu-queue retry --id STABLE-UUID
```

`cancel` only cancels a job that has not been submitted. For a running render use
ComfyUI's own controls after identifying the correct job; do not interrupt a shared
GPU's unrelated work. Empty queues mean the workers are waiting, not rendering.

## Review GPU files without a desktop

Hosted Work provides `inspect_ssh_image`: read an absolute PNG/JPEG path (up to
5 MB in GPT mode, 2 MB with local Qwen) through an enabled, pinned SSH connection. It uses SFTP, respects the selected GPT/local-Qwen vision mode, returns the exact
file SHA256 and either pixels or a focused local observation, and requires current SSH/member
permissions as command execution. There is no shell interpolation or desktop lease.
Images stay out of saved chat/checkpoint data; their hash remains in the tool result.
Local-Qwen mode never falls back to cloud image inspection without a settings change.
Larger sources can be preserved while creating smaller JPEG review frames on the GPU.
SSH image reads pipeline eight bounded chunks and allow up to three minutes for transfer.
Keepalive acknowledgments tolerate slow uploads; command and permission checks remain
bounded independently. Tailscale tunnels expire after ten idle minutes and no longer
terminate active streams at a fixed one-minute age.

For video review, use `execute_ssh` to extract frames with ffmpeg on the GPU computer,
then inspect the relevant frames. Review adequate frames for motion/continuity and
run full decode, original-audio and timing checks separately. One sampled frame
cannot certify an entire video. ThinkCentre availability does not gate GPU rendering
or this file-review path. ComputerUse is still needed for actual desktop interactions.

## Operations and verification

Keep owner workspace SQLite backups, the pre-release compose file, and previous
app/worker/connector images. Deploy additive schema changes and roll back images
without restoring stale data. Restart the cloud worker gracefully against the app
so cancelled writers acknowledge settlement and recovered jobs can be claimed.
Do not change the separate legacy Boardly database or deployment.

Targeted regressions: `test/platform-reliability.js`, `test/runtime-recovery.js`,
`test/gpu-queue.py`, existing chat/concurrency/cloud/provider/member/management tests,
`test/employees-browser.cjs`, `test/employee-manager.js` and `test/ssh-images.js`. Fault coverage includes 16 simultaneous connector
requests, allowance-to-local tool execution, transient retries, persisted public
tool results, cancelled writer settlement, lease credential replacement, lost GPU
submission acknowledgments, and employee handoff deduplication.
