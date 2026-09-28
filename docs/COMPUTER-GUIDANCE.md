# Guide an agent from its computer window

Below an agent's live desktop, **Guide this task** sends instructions to that
same Work run and saves them in its project conversation. Send or Ctrl/Cmd+Enter
submits. A failed send retains the draft; retrying the same request cannot create
a duplicate instruction.

**Queued for agent** means saved, not yet delivered. **Received by agent** means
the Codex turn started with the instruction, or the hosted provider returned a
response to it. It does not mean the requested action has been completed. Recent
instructions and current run progress are available in the viewer.

Codex interrupts its current turn and resumes the existing session with the
original task and new guidance. It must inspect current state and uncertain
operation outcomes before repeating actions. Hosted AI delivers guidance between
steps and skips obsolete tool calls from an earlier plan. New guidance also
interrupts hosted provider retry backoff; it cannot restore an offline provider.
An already-running remote action may finish before guidance is applied.

Paused Work runs offer **Resume with instruction**. Completed/cancelled runs do
not restart automatically. Human desktop control remains separate: use **Give
Back to Agent** before resuming a task paused while you control the desktop.
Typing guidance never types it into the remote desktop.

Only the workspace owner or the run's requesting user with current project edit
access can send guidance. Ordinary viewers cannot redirect another user's run.
Manual desktop sessions without an associated Work run have no instruction box.
The inbox persists in the tenant database and survives app/worker restarts.

Verification: `node test/agent-guidance.js` exercises native stalled-turn delivery,
hosted in-flight changes and retry backoff, idempotency, access boundaries,
acknowledgements, human control, paused resume, terminal races and provider failure.
`test/live-computer-browser.cjs` covers HTTP/direct viewer transports, uncertain
send retries, delivery feedback and responsive layouts from 320 to 1920 pixels.
