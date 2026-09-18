# Project Files and folders

Open **Files → New folder**, enter a name and press **Create folder**. The new folder opens immediately. Create another folder inside it for subfolders. The breadcrumb lets you return to a parent folder or the top-level Files list.

**Upload files** and **Link an existing file** save into the open folder. **Move** beside an existing file lets you choose any folder in the same project, or **Files (top level)**. Uploaded and linked files both support moving. Folder names can be changed with **Rename folder**. **Delete empty folder** is available once all files and subfolders have been removed or moved elsewhere.

Existing files remain at the top level after upgrading. Organizing a file preserves its ID, upload bytes, download URL, original name and storage usage. Folders are project metadata; their names are not filesystem paths. Editors can organize their shared projects. Viewers can browse folders and download files; they cannot create, rename, delete or move them.

## API and agents

`GET /api/boards/:boardId/files` continues to return all project files for existing clients, with `folder_id` and `folder_path`, plus a `folders` array. Each folder has `id`, `uuid`, `board_id`, `parent_id`, `name`, `path` and `created_at`.

- `GET/POST /api/boards/:boardId/folders` lists or creates folders. Creation accepts `name` and optional `parent_id`.
- `PATCH /api/project-folders/:id` accepts `name`.
- `DELETE /api/project-folders/:id` refuses nonempty folders.
- `PATCH /api/project-files/:id` accepts `folder_id`, with null meaning top level.
- File uploads and file links accept optional `folder_id`; omission retains the top-level behavior.

Names must contain 1–120 characters, with no slash, backslash, control characters, `.` or `..`. Sibling names are unique under SQLite NOCASE comparison. Subfolders are limited to 20 levels. Every supplied parent or destination is checked against the file/project scope. Invalid upload destinations clean up uploaded bytes; member access is revalidated after upload.

MCP adds `list_project_folders`, `create_project_folder`, `rename_project_folder`, `delete_project_folder` and `move_project_file`. Existing `add_project_file` and `add_project_file_link` accept optional `folder_id`. File lists and chat snapshots include folder paths. Native workers continue downloading files through their existing project/job-scoped routes, and hosted Work agents can create folders, save files into them and move project files. Ask and Plan remain read-only.

## Migration and checks

The additive migration creates `project_folders` and adds nullable `project_files.folder_id`. No existing upload is renamed or moved on disk. Back up the live databases and uploads before deployment. Rolling back the app image preserves folder metadata; the older UI presents all files as a flat list.

Run `npm run test:files` for legacy migration, folder validation, uploads/links, move and download preservation, storage, access/revocation boundaries, actual MCP calls, native worker downloads, hosted agent folder actions and project deletion. `node test/project-folders-browser.cjs` exercises the browser workflow, downloads, reload, viewer access and 320px/390px layouts using the local authenticated fixture. Project Files remain a cloud feature; the old desktop sync scope is unchanged.
