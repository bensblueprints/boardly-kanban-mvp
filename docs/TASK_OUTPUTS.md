# Task output shortcuts

Open a task or its output-file badge, then select a file under **Outputs** to
preview or download it. Editors can link an existing file from the same project
and remove a shortcut without deleting the original file. Viewers can read and
download outputs within their existing project access.

[Resumable uploads](FILE_UPLOADS.md), native task-chat output uploads and hosted AI `save_file` calls link saved files
to the current task. MCP `add_project_file` accepts `card_id`; `list_task_files`
and `link_task_file` support other task workflows. Whole-project conversations
without a task require an explicit link to the relevant task.

The additive `task_file_links` table stores relationships only. Existing native
outputs are linked from recorded job/thread provenance when the workspace opens;
filenames are never used to guess task identity. Hidden shortcuts survive that
backfill and upload retries. Project moves fence old-project files. Deleting a
task keeps its project files, and deleting a project file removes its shortcuts.

Previews support spreadsheets/CSV, Markdown/text/source, raster images, PDF and
browser-supported audio/video. HTML and SVG are displayed as source. Spreadsheet
parsing runs in a worker with a ten-second timeout and shows up to 200 rows, 50
columns and 30 sheets. Text previews show up to 200 KB; files above 20 MB and
unsupported formats retain a download action. Original downloads are complete.
The browser's native viewer renders PDF from a blob forced to `application/pdf`.

The spreadsheet dependency uses SheetJS's pinned 0.20.3 tarball from its
[official installation source](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/),
with integrity recorded in the lockfile. It is bundled into the preview worker.

Validation: `npm run test:files`, `npm run test:mcp`, `npm run test:members`,
`npm run test:cloud`, `npm run test:management`, `npm run test:mcp-worker` and
`npm run build`. `node test/task-files-browser.cjs` uses Chrome and Playwright
(`BOARDLY_PLAYWRIGHT_MODULE` can override its module path) to exercise real
task/preview interactions, shared access, mobile bounds and downloads.

For an app rollout with active computer work, let the existing worker stop
gracefully while the old app is available so its brokers can release desktop
leases. Recreate the app, then start the same worker image. Its recovery protocol
preserves jobs and conversations and checks existing external outcomes. Do not
restart external generation jobs or modify their statuses. Rollback requires
only the previous app image; keep current file bytes and database rows.
