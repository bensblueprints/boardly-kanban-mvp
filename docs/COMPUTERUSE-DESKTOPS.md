# ComputerUse in Boardly

Connect the ComputerUse API on the **Companies home page → ComputerUse**, using
`account:read`, `desktop:read` and `desktop:write` scopes. The key is encrypted
per account on the server; workers receive neither that key nor desktop leases.
Keys created by ComputerUse expire after 30 days. Renew an expired key in
ComputerUse, replace it in Boardly, then select the company/project assignments
again. Replacing/disconnecting a key clears assignments deliberately.

The same connected API inventory is available across all companies in that Boardly account.
The **Company computers** panel appears directly on every company home page and
assigns multiple computers to that company's projects.
**Project → Computer use** can override the selection, disable it, or inherit it.
The picker loads **Free Desktops** and paid rentals automatically from the API.
The old $29.99 Boardly offer and availability-request flow are retired. Boardly
shows actual assigned inventory rather than a second rental checkout. Assigning a free desktop
does not create a Stripe subscription or payment. Existing API `rental_ids`
remain compatible; free desktops use `desktop:<UUID>`. Responses expose `kind`
and `desktop_id` explicitly so free computers are never represented as rentals.

Enable **Allow permitted Work agents to view and control these computers**.
Members also need the separate Computers permission. Company/board AI conversations
can see the permitted project computer assignments; Work agents receive the
existing controls when their company or project enables them. Old inspection-only grants
keep `allow_control=false`; explicit control permission is required for inputs
and screenshots. Ask/Plan cannot operate desktops.

Both the owner Codex worker and API/ChatGPT Work agents can inspect, screenshot,
click, type, move, drag, scroll and release assigned desktops. A single Work run
holds an exclusive 60-second renewable lease. Completion releases it; if the
worker crashes, it expires. Input operations have stable IDs and are never
blindly retried. After an uncertain result, a fresh screenshot is required.

When a Work agent starts using a computer, a live window opens in Boardly.
You can watch its screen and current work, then use **Maximize** for more space.
Choose **Take Over** to use the mouse and keyboard yourself. The agent cannot
see the screen or send input while you have control. The text box at the bottom
also lets you type or paste into the remote computer, including on a phone.
Choose **Give Back to Agent** when finished. Boardly returns control and resumes
the linked saved assignment if it is waiting for your handoff.

Closing the window keeps your control in place. **Open computer** brings it back;
the same button is available beside each assigned project computer. Dismissed
work will not repeatedly pop up during the same browser session. Another person
cannot see or take over a screen you are controlling. If your Boardly sign-in has
expired, use the original [ComputerUse portal](https://computeruse.space/portal)
to recover control. API keys cannot force human handback.

Sharing a desktop between projects shares its files and login sessions;
use different desktops where those need to be separate.

Screenshots stay out of Boardly chat/activity/files unless an agent is explicitly
asked to save one. API model context retains at most its latest frame. Subscription
and ChatGPT bridges pass temporary JPEG attachments to Codex and remove their temp
directory on completion. Existing subscription request payloads are cleared by the
response lifecycle. This is not a guarantee of physical erasure from storage or
of provider retention policy. Desktop files remain until the owner deletes or
resets them; ending an agent run does not wipe the VM.

Implementation reference for image tool responses:
[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).

Verification: `node test/computeruse-account.js`, `node test/computeruse-desktops.js`,
`node test/computeruse-agent-vision.js`, `node test/computeruse-worker.js`,
`node test/project-computers.js`, `node test/project-computers-browser.cjs`,
`node test/owner-funding.js`, `node test/cloud-api-agents.js`, `node test/chatgpt.js`.

Live viewer checks: `npm run test:computer-viewer` and
`node test/live-computer-browser.cjs` (Playwright and Chrome required;
`BOARDLY_PLAYWRIGHT_MODULE` / `BOARDLY_CHROME_PATH` can select local installations).
The browser test uses a synthetic desktop and never touches a real account.

Operators: set the same random 32-byte lowercase hex
`COMPUTERUSE_BOARDLY_VIEWER_KEY` on the Boardly application and ComputerUse API.
Keep it out of worker environments. Browser routes require a verified sign-in
session and current project Computers access; they are excluded from MCP.
The backend signs a 30-second, one-use assertion bound to the user/session,
connected API credential, desktop, command and exact request body. The provider
still checks credential scopes, account ownership, control holder, revocation
and guest fencing. This secret does not enable unowned or unassigned desktops.
