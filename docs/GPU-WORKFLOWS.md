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

Create a workflow of up to 12 **AI prompt**, **image** and **video** steps. Start
it with an idea. AI steps use the account's configured AI connection, including
its existing local-fallback setting. AI text steps have no action tools; use
them to write/transform scripts, prompts or captions. Media steps use the saved
template and actual local GPU. An existing Granny publishing service remains
responsible for its own posts; these workflows do not implicitly publish media.

Runs snapshot their steps/templates when started, so editing a saved workflow
does not change a running one. Downloads are streamed through authenticated SSH
from the configured ComfyUI output endpoint, without public GPU ports. Outputs
remain on the GPU; deleting them there also removes download availability.

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
  preserves an already submitted render. Such renders can finish in ComfyUI.
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
