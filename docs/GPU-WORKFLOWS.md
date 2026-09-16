# Boardly GPU Workflows

Open **Settings → GPU workers**. Select an existing account SSH computer with
Work access enabled, name the worker, and connect. Boardly checks `nvidia-smi`
and ComfyUI before saving it. The **GPU Workflows** navigation entry appears
after at least one worker is registered. GPU settings, jobs and outputs are
private to the account owner; shared company/project membership does not grant
access to the owner's entire GPU fleet.

## Queue

The dashboard reads NVIDIA memory/utilization/temperature, ComfyUI running and
pending jobs and recent history, the existing Boardly GPU SQLite queue, and an
optional producer directory containing `*/manifest.json` batches. Reads do not
load models or interrupt jobs. The Granny producer adapter includes jobs waiting
outside ComfyUI and deduplicates them by prompt UUID. The most recent three
batches and bounded recent engine/queue history are shown. Errors retain the
last reading and mark it stale. Refresh runs every 15 seconds while the page is
visible; **Pause updates** only pauses the display.

## Workflows

Add image/video templates in GPU worker settings, using ComfyUI's **API format**.
Templates must use models and nodes installed on that engine. Configure every
ComfyUI port sharing the physical GPU, so a new render waits for existing work
on the other ports too. A worker monitors one selected GPU; ComfyUI's device
assignment remains in its own startup configuration.

Supported template values:

- `{{prompt}}`: the generation step's resolved prompt.
- `{{previous_text}}`: the last AI text result, or the initial prompt.
- `{{seed}}`: a fresh numeric seed, persisted with the compiled graph.
- `{{run_id}}`: a stable output prefix component.
- `{{previous_file}}`: a preceding image on the same worker and ComfyUI port,
  referenced with ComfyUI's `[output]` annotation. Cross-worker image transfer
  is not supported by this version.

Use **Add workflow** on the dashboard to create up to 12 **AI prompt**, **image**,
**video**, **email**, **social post** and **custom output action** steps. Start
it with an idea. AI steps use the account's configured AI connection, including
its existing local-fallback setting. AI text steps have no action tools; use
them to write/transform scripts, prompts or captions. Media steps use the saved
template and actual local GPU. Each GPU card also has **Add job** for a direct
image/video job using one of its generation templates.

For an output action, choose the project whose connections should run it and
write the instruction: recipient, platform/account, caption and any product
link. Starting the workflow authorizes those saved actions. Media is copied
into project Files through the quota-aware resumable uploader, then handed to
a durable project Work assignment. Open its conversation to see results,
provider confirmation or missing access. Email/social availability depends on
the selected project and AI runtime having the needed enabled connections;
there is no separate unrestricted mail or publishing credential. Existing
Granny publishing remains its own service.

Output-action assignments use stable IDs and reuse completed uploads after a
restart. They never intentionally recreate a send/post assignment on a poll.
The Work engine must reconcile an uncertain external send before retrying it.
Resolve a blocked action in its project conversation, resume that assignment,
then resume the GPU workflow to observe its completion.

Runs snapshot their steps/templates when started, so editing a saved workflow
does not change a running one. Open a job to see its prompts and outputs.
**Edit queued prompt** updates a future step with conflict detection. Jobs
already handed to ComfyUI retain their original prompt.

Output cards open image previews or video/audio playback in Boardly, with a
download button. Downloads are streamed through authenticated SSH
from the configured ComfyUI output endpoint, without public GPU ports. Outputs
remain on the GPU; deleting them there also removes download availability.
Files handed to an output action are retained in project Files. Finished
Granny videos use their existing Boardly upload receipt when available.

## Existing queue prompt editing

The updated `scripts/gpu-queue.py` worker claims an unchanged queued graph in
a SQLite write transaction before submission. The editor requires the running
worker’s `queue.db.prompt-edit-v1` capability marker and zero prior attempts.

For the existing Granny producer, stop only the supervisor, run
`python3 scripts/install-gpu-producer-bridge.py /path/to/continuous-producer.py`,
restart the supervisor and verify it recovered the same ComfyUI prompt UUID.
Only then create `<manifest-root>/.boardly-prompts/enabled`. Never restart the
renderer for this update. The installer keeps a source backup and rejects an
unfamiliar producer. Edits live in locked, atomic sidecars, so a producer
finishing an earlier render cannot overwrite them. Its durable claim closes
the edit window before saving the creative or graph; claimed edits survive a
supervisor restart. Spoken scripts are limited to 40 words for 15-second jobs.

## Recovery and controls

- Runs and completed step outputs persist in the workspace database. The cloud
  scheduler continues without an open browser and recovers pending work after
  a Boardly restart. The GPU computer and Boardly server must remain online.
- Render submission writes an fsynced receipt to
  `~/.local/share/boardly-gpu-workflows/receipts/<UUID>.json` before calling
  ComfyUI. Lost acknowledgements reconcile against that UUID. A missing
  submitted job blocks for reconciliation instead of silently rendering twice.
- Existing ComfyUI jobs and the existing durable GPU queue get priority. There
  is no global stop, model unload or engine restart.
- Pause/resume controls future workflow steps. **Cancel remaining steps**
  preserves an already submitted render and cancels pending action assignments.
  A render or external send already in progress may finish.
- AI failures expose **Retry AI step**. For a failed/lost render, inspect the
  engine/output files and fix the template before explicitly starting a new run.
- Revoked SSH access blocks subsequent work and terminates output downloads.

## Verification

`node test/gpu-workflows.js` checks gates, isolated owner routes, templates,
prompt → image → prompt, duplicate requests, restart reconciliation, stale
readings, cancellation races and port restrictions. `python3
test/gpu-workflows-probe.py` checks receipt safety after lost acknowledgements,
existing-engine priority and history success/failure. `node
test/gpu-workflows-browser.cjs` exercises the real cloud API with a synthetic
SSH worker: connection unlock, template creation, 40-job display, builder/run,
mobile layouts and reduced motion. Production hardware acceptance is recorded
on Boardly task 397 and in the deployment operations directory.

Additional verification: `node test/gpu-output-actions.js` streams a real 5 MB
HTTP response through an SSH-compatible channel, checks exact bytes, quota,
revocation, deduplicated uploads and project-scoped action dispatch. Workflow
tests cover prompt-edit races, action handoff/restart/blockers/cancellation;
Python tests cover producer claims and edits racing durable queue submission.
Browser tests also exercise preview/download through a real SSH forward,
queued editing, per-GPU submission and email/social builder steps.
