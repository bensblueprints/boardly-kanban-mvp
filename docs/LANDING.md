# Public homepage and company overview

The cloud app serves a static public product page at `/`; signed-in workspaces use `/app`, with Clerk routes at `/sign-in` and `/sign-up`. Older root hash bookmarks are forwarded to `/app` without losing their project route. App launchers should open `/app`.

The homepage describes the actual product, shows screenshots captured from the web UI and a dedicated desktop browser window with isolated demonstration data, and offers Basic Free without a credit card. It distinguishes provider AI costs and the current desktop cloud experience. The legacy native application's offline database is not synchronized with this cloud workspace.

Public signup requires `BOARDLY_OWNER_ONLY=false` and Clerk `auth_access_control.sign_up_mode=public`. Basic Free uses existing plan limits; paid billing is a separate configuration and is not required to create an account. Never publish secret environment files, Clerk credentials or production screenshots containing customer data.

**Companies** includes a live graph of all companies, their projects and project/company/board conversation agents. Gray means nothing actively running; red means blocked; yellow requires a fresh heartbeat; green requires every non-archived task complete and no pending agents. Queued work remains gray, empty companies remain gray, and blockers take priority. A 15-second freshness window keeps working indicators truthful when updates fail. Filters, keyboard navigation and graph-contained horizontal scrolling support large workspaces and smaller screens.

Generate screenshots with `BOARDLY_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/capture-marketing.cjs` in a graphical session. Run browser verification with the same module setting and `node test/landing-github-browser.cjs`; `BOARDLY_BROWSER_OUTPUT` optionally saves desktop/mobile homepage captures. `npm run test:overview` covers aggregation, more than 100 simultaneous records, color precedence and tenant/member isolation.
