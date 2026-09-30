# Work implementation evidence

The live hosted runner rejected GitHub reads with zero or omitted line ranges.
It also accepted a final text response as completion after only card edits.

GitHub reads now normalize the first line, default to 100 lines, cap each page
at 200 lines, and return a continuation line. Invalid ranges fail before a
network request. Activity includes the actual sanitized error, read path/SHA,
commit SHA, or command exit code.

Hosted Work records successful tool receipts separately from model prose.
Receipts survive context compaction and restart; existing checkpoints seed
them idempotently. Explicit implementation requests with an enabled repository
cannot finish without a recorded source commit. Document-only commits and
Boardly attachments do not count. Two correction turns are allowed; another
unsupported completion stops as unverified. Planning and read-only requests
are exempt, and managers continue to use their existing child-result gate.

This is a minimum evidence check, not a claim that any commit proves the whole
assignment works. The runner instructs the model to distinguish committed,
tested and deployed. Command exit codes do not automatically certify tests.
Intent detection is conservative and heuristic; ambiguous requests are not
automatically classified as implementation. No empty/token edit is requested.

Validation: GitHub range/pagination regression tests, hosted task-only and
document-only false-completion tests, source-commit and planning acceptance,
receipt recovery, GitHub permissions/concurrent changes, persistent chat
connections, and cloud Work blocker/resume checks. The native guidance test
times out under Windows on both the unchanged base and this patch.

`test/local-work-smoke.js` is an opt-in real local-model check against isolated
Boardly state and in-memory GitHub. It checks generated arithmetic source with
three runtime assertions; it never writes to a real repository or project.

Deployment uses `scripts/deploy-work-evidence.py`: verify baseline file hashes
and container identity, build on the existing image, run isolated integration
tests, check recoverable job checkpoints, back up SQLite consistently, replace
only the app service, verify health and deployed hashes, and roll back the app
image on a failed health check while preserving current data.
