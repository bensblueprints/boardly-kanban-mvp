# ComputerUse in Boardly

Connect the ComputerUse API in **Account & AI → ComputerUse account**, using
`account:read`, `desktop:read` and `desktop:write` scopes. The key is encrypted
per account on the server; workers receive neither that key nor desktop leases.
Keys created by ComputerUse expire after 30 days. Renew an expired key in
ComputerUse, replace it in Boardly, then select the company/project assignments
again. Replacing/disconnecting a key clears assignments deliberately.

**Company → Computers** assigns multiple computers to the company's projects.
**Project → Computer use** can override the selection, disable it, or inherit it.
The picker includes **Free Desktops** and paid rentals. Assigning a free desktop
does not create a Stripe subscription or payment. Existing API `rental_ids`
remain compatible; free desktops use `desktop:<UUID>`. Responses expose `kind`
and `desktop_id` explicitly so free computers are never represented as rentals.

Enable **Allow permitted Work agents to view and control these computers**.
Members also need the separate Computers permission. Old inspection-only grants
keep `allow_control=false`; explicit control permission is required for inputs
and screenshots. Ask/Plan cannot operate desktops.

Both the owner Codex worker and API/ChatGPT Work agents can inspect, screenshot,
click, type, move, drag, scroll and release assigned desktops. A single Work run
holds an exclusive 60-second renewable lease. Completion releases it; if the
worker crashes, it expires. Input operations have stable IDs and are never
blindly retried. After an uncertain result, a fresh screenshot is required.

Open the desktop in [ComputerUse](https://computeruse.space/portal) and choose
**Take control** to pause agent screenshots and inputs while entering credentials.
Explicitly hand back control before agents continue. API keys cannot force human
handback. Sharing a desktop between projects shares its files and login sessions;
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
`node test/owner-funding.js`, `node test/cloud-api-agents.js`, `node test/chatgpt.js`.
