# Company storage, rules, skills and Master Chat

Open a company to find **Company storage** and **Rules & Skills**. **Master Chat · all companies** is above the company list and on company home pages.

## Connect your storage

1. Open the company, choose **Company storage**, then **Connect storage**.
2. Choose Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, another S3-compatible service, or WebDAV / Nextcloud.
3. Give it a friendly name, such as “Brand assets.”
4. For S3, copy the bucket name, region and access keys from your provider. Custom services also need their S3 endpoint. R2 uses `auto` as its region. For WebDAV, copy your WebDAV address, username and app password.
5. Optionally restrict the connection to a folder, such as `marketing/`. Boardly only accesses paths inside that root. For WebDAV, the selected folder must already exist.
6. Leave uploads disabled for browsing and downloading, or enable uploads for yourself and this company’s editors.
7. Press **Test & connect**. Boardly opens the selected folder before saving the connection. This test reads the folder; it does not create a test file or prove upload permissions.

Use **Browse** to open folders and download files. **Upload file** saves a new file in the current folder. Existing files are not overwritten; rename a new upload when the name already exists. S3 folders offer **Load more files** when needed. WebDAV folders are limited to 2,000 returned entries. Transfers are limited to 25 MB each.

Use a publicly reachable HTTPS endpoint on port 443. Private network, localhost and Tailscale endpoints are not supported by this connector. No connection credentials are returned to the browser, AI, or ordinary members after saving. To rotate credentials, connect and test the replacement, then disconnect the old entry. Disconnecting removes Boardly’s saved connection and leaves the provider’s files intact.

Company members can browse/download. Company editors can upload when the owner enables it. Project-only guests do not receive access to the company’s external drive. Only the account owner manages connections. External files stay with the provider and use its allowance and pricing; Boardly’s existing project Files section and upload quota continue independently. No automatic migration, background sync, external-file AI ingestion, provider OAuth or external file deletion is included.

Provider instructions: [Amazon S3 access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-management.html), [Cloudflare R2 tokens](https://developers.cloudflare.com/r2/api/s3/tokens/), [Backblaze S3 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api), [Wasabi access keys](https://docs.wasabi.com/docs/access-keys-1), [Nextcloud WebDAV](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html). S3 browsing uses the provider’s [ListObjectsV2 API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).

## Save workflow rules and skills

**Company workflow rules** hold instructions that apply throughout the company. For example:

> Read the current task before working. Keep its checklist updated. Ask me before publishing marketing posts. Explain blockers and the next action needed.

Press **Save company rules**. To save a repeatable process, choose **New skill** or one of the task workflow, brand voice, or marketing review templates. Give the skill a lowercase name such as `marketing-review`, describe when to use it, and write the steps. Enable it when it is ready.

**Import SKILL.md** opens an existing Markdown skill in the editor, disabled by default. Review it, choose whether to enable it, then save. **Export SKILL.md** downloads the name, description and instructions in a portable file. This library supports instruction-only Markdown skills; it does not install or execute bundled scripts, tools or plugins.

The account owner edits rules and skills. Company members can read/export them. Enabled instructions are supplied to the company’s native worker and API-model conversations, project/task Ask, Plan and Work, company/board discussions, and existing-company planning. The owner MCP board context includes them too. New runs use current rules; API iterations refresh them. A running native worker receives a snapshot when claimed. Skills remain subject to user instructions, existing access permissions and mode restrictions. Keep secrets in the connection forms.

Each company can save 50 skills. Rules can contain 20,000 characters; an individual skill can contain 15,000 characters. Rules plus enabled skill instructions/descriptions can total 40,000 characters. Disabled skills do not enter ordinary AI context. A project moved to another company uses its new company’s instructions in subsequent runs.

## Manage settings through Master Chat

Open **Master Chat · all companies** and say what you want. Examples:

- “Show me the rules for my companies.”
- “For Acme, add a rule requiring approval before marketing posts are published.”
- “Turn Acme’s checklist workflow into an enabled skill.”
- “Rename Acme’s Marketing project to Growth.”
- “Disable uploads for Acme’s Brand assets storage.”

Master Chat identifies companies, reads current settings and prepares change previews. Each preview names the company, the setting and the exact new values. **Apply changes** writes through the same app APIs used by the settings screens and saves a receipt. **Dismiss** leaves the setting alone. Previews expire after one hour; if the underlying setting changed, request a fresh preview. An uncertain result is never automatically retried.

Supported edits: company and company-board names/descriptions; project names/descriptions/colors/emojis/stars; company rules; creation, editing, enabling and removal of skills; storage names/upload permissions; existing company/project GitHub repositories, branches and agent access. The expandable **Settings I can change** list shows the current scope. New credentials and other settings still use their dedicated forms. Master Chat does not launch company agents, send team-chat messages, publish, spend money, or execute arbitrary commands.

Only the account owner has Master Chat. Its history, tools and settings remain within that owner’s workspace. A member of a shared company cannot use the sponsoring owner’s Master Chat or inspect their other companies. Master Chat uses the owner’s selected API or connected subscription, with the same funding configuration as other AI conversations.
