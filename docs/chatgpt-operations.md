# Customer ChatGPT connections

The app embeds Codex authentication using the official [app-server device-code protocol](https://learn.chatgpt.com/docs/app-server#3b-log-in-with-chatgpt-device-code-flow). Customers approve a code on OpenAI's website. Device-code login may require enabling it in ChatGPT security settings or workspace permissions; see [OpenAI authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

The customer's ChatGPT plan must allow Codex and have usage available. This does not import ChatGPT conversations. ChatGPT usage does not create API billing records or fall back to an API key. API billing remains a separately selected option. Shared work is funded by its sponsoring owner; personal settings always belong to the authenticated actor.

## Service boundary

`Dockerfile.chatgpt` pins Codex 0.153.4. The connector only receives account hashes and text conversations from the authenticated app over its private compose network. No public ports, generic RPC proxy or caller-supplied paths are exposed. Store a random connector token in a private file owned by UID 1000 and mount it read-only in the app and connector. `docker-compose.chatgpt.yml` is an example overlay for the repository's cloud compose file.

Each verified Clerk user ID maps to its own SHA-256 profile directory. Codex manages its credential cache under that profile, with restricted filesystem permissions. Treat the entire profiles volume as credential material; never expose it through project files, logs, repository backups, or the app's general data volume. The connector does not mount company databases, project files, SSH credentials, or the owner's worker profile. Back up profiles only to protected storage if needed.

Auth uses a private stdio app-server process. Generation uses ephemeral Codex runs with execution, shell, browser, MCP, plugins, apps, hooks, host skills, memory, and subagents disabled. The model can propose catalog actions; the app checks project and member permissions before executing each action. Ask and Plan have no action catalog. Up to four responses per account and sixteen across the connector can run concurrently; capacity errors preserve the saved assignment.

Disconnect invalidates in-flight responses, asks Codex to log out, stops its processes and deletes its profile cache. A status request cannot reopen a profile during disconnect. Expired/cancelled sign-ins remain retryable. Limits and rejected credentials produce guidance to check Account & AI. Reconnecting requires OpenAI approval again.

## Verification and rollout

Run `npm run test:chatgpt`, `node test/chatgpt-onboarding-browser.cjs`, `npm run test:all`, and `npm run build`. The fixtures exercise real child processes with a controlled Codex protocol provider, account isolation, actions, cancellation, quota errors and UI behavior. They do not represent a live OpenAI account approval.

For live acceptance, open Account & AI → Connect ChatGPT, approve the displayed code with the intended account on OpenAI, and use Test ChatGPT connection. A verified timestamp is stored only after an actual AI reply. Send an Ask message in a project and verify the reply/activity. Check that existing owner workers and unrelated integrations remain healthy.

`account_onboarding` in personal-ai.db stores welcome progress per authenticated user. New users see the five-step guide; completion/skip survives reload and workspace switching. Help & tutorial can replay setup or download the user guide. The content source is `GettingStarted.jsx`; keep `docs/boredly-tutorial.md` aligned when editing lessons.

Deployment must preserve all current data. Back up the app databases before first rollout. Rollback the application image and connector configuration together; the additive onboarding table may remain. Do not restore a stale database over newer project work. The legacy owner worker stays separate and retains its original authentication.
