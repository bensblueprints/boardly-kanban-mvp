# Large file uploads

Project Files and task attachments accept every file type. Uploads use 4 MiB
requests and have no separate per-file cap; account allowance and available server
storage determine what fits. Files shows the current filename, progress, Pause and
Resume controls. After refreshing, selecting the same unchanged file resumes its
saved upload. Unfinished uploads expire after seven days.

The server stores acknowledged offsets, syncs chunks to disk before acknowledging
them, checks retried bytes, and publishes the original file only after completion.
An optional SHA256 verifies the whole file. Repeating completion returns the same
file ID. Completed transfers retain their receipt while the original file exists.
Transfers are scoped to the workspace, project and actor; current member access is
rechecked when publishing. Reserved uploads count toward account allowance.

MCP's inline upload still carries at most 2 MB per request. Larger files use
`start_file_upload`, `file_upload_status`, `upload_file_chunk` (up to 1 MiB of
original bytes encoded as base64), `finish_file_upload` and `cancel_file_upload`.
Use a script to handle the bytes instead of including file contents in model text.
These tools use the authenticated management API in cloud mode.

Every native Work run receives `BOARDLY_FILES_SOCKET` and
`scripts/project-file-client.cjs`. After staging a regular file in the run's output
folder, call `upload({name})` to save it immediately and receive its ID, size and
SHA256. The upload uses bounded memory, resumes interrupted transfers and checks
that the local file did not change. Remaining outputs are saved automatically
when the run ends; already saved outputs are reused. Agents must not wait for
post-run ingestion as a prerequisite to ending a run.

Generated-file checks inspect known private project values, and recognizable
credentials in text files. Compressed archives and media are never processed by
the log formatter's card-number heuristic. This fixes two valid image archives
whose binary data previously triggered that heuristic. Files are preserved exactly,
not redacted or rewritten. Symlink outputs remain unsupported.

The additive `file_uploads` table and `uploads/.partial/` store transfer state.
The original project/attachment tables, folders and task shortcuts remain the
published-file records. Rollback can retain these tables and partial files, though
old clients/workers do not support resuming the new transfer protocol.

Tests: `npm run test:files`, `node test/management-api.js`, `npm run test:members`,
`node test/cloud-agents.js`, `npm run test:cloud`, `npm run test:mcp` and `npm run build`.
`node test/file-upload-browser.cjs` checks pause/reload/resume, progress, mobile
layout, a task attachment over the previous cap and viewer controls. Server tests
include a 110 MB upload/download, exact checksums, retries, quota reservations and
access revocation. The worker test verifies a file ID during an actual worker turn
and checks post-run deduplication and the binary archive regression.
