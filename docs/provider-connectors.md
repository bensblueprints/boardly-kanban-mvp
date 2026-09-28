# Customer-owned AI and media connections

Use the profile menu → Settings → Connectors. Every customer supplies their own AI account. Credentials are stored per account; a disconnected customer cannot borrow the platform owner's Codex login or API key. AI work in a shared company uses that company's owner's connection. Members do not receive its credentials. Ben's existing worker remains available only in Ben's workspace.

## Choose the AI for Boardly agents

| Connector | Authentication | Setup |
| --- | --- | --- |
| Codex / ChatGPT | Official OpenAI device-code OAuth | AI & models → sign in. Open the displayed OpenAI URL and approve the code using your own account. |
| OpenAI API | Your API key | AI & models → My OpenAI API key → choose model → Save. |
| Claude | Your Claude API key | Claude & Claude Code → Verify connection → choose returned model → Verify & save model → Use for Boardly agents. |
| Kimi | Your Kimi API Platform key | Kimi & Kimi Code → verify → choose model → activate. Kimi Code/chat subscriptions and API billing are separate. |
| Local AI | Your Tailscale device, server port, optional API key | Connect Tailscale, run Ollama/LM Studio/vLLM on that device's Tailscale address, choose device/port, verify loaded models and activate. |

Saving Claude/Kimi/local settings does not switch the current AI. Activation is explicit. Disconnecting the selected provider pauses its work until a connection is selected again. Provider generation is never automatically retried after an uncertain network outcome. New provider token counts are recorded when supplied; unknown costs are not guessed. Each provider handles billing and budget limits. Boardly-funded API billing is no longer offered; existing workspace and seat billing is unchanged.

Model discovery lists models without making a paid generation. Models must support tool calling for Work, and image input for ComputerUse screenshots. A model appearing in the provider list does not prove its tool/vision capabilities. Ollama typically uses port 11434 and LM Studio 1234; choose the actual server port. Local model requests use a server-validated peer in that customer's Tailscale network. An arbitrary public URL or the Boardly server's localhost is not accepted.

Codex authentication follows [OpenAI's app-server device-code flow](https://learn.chatgpt.com/docs/app-server#3b-log-in-with-chatgpt-device-code-flow). Device login may need enabling in the customer's ChatGPT Security settings; see [OpenAI authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices). Each account has a separate private Codex profile and a minimal process environment without inherited provider keys. No customer has to send a password or copy an auth cache to Ben.

Claude powers Boardly's own permission-checked agent loop through the Messages API. This is not a hosted Claude Code subscription. Customers can also use their existing Claude Code locally; its sign-in stays with their client. See [Claude Agent SDK authentication](https://code.claude.com/docs/en/agent-sdk/overview) and [Claude Code usage requirements](https://code.claude.com/docs/en/legal-and-compliance).

Kimi uses the API Platform's OpenAI-compatible endpoint, with tool/reasoning continuation kept in memory and omitted from chat history. References: [Kimi API](https://platform.kimi.ai/docs/overview), [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat).

## Use an external coding client

Developer & MCP provides a separate revocable Boardly key plus Codex, Claude Code and Kimi Code configurations. The AI account remains connected in that customer's coding client. Boardly MCP currently remains restricted to the platform owner under the existing cloud launch policy; this release does not change that policy. All account owners can configure the internal AI connectors above.

Claude Code requires `type: "http"` for a remote JSON entry. Kimi Code accepts `url` plus `bearerTokenEnvVar: "BOARDLY_MCP_TOKEN"` in `~/.kimi-code/mcp.json`; start a new session after adding it. Never commit the secret key. Guides: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Kimi Code MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html).

## fal and Higgsfield images/video

1. Open the provider in account settings and save your own API credentials. Higgsfield needs a key ID and secret. The key remains encrypted on the server. Saving does not run a paid test; the UI says it is unverified until the provider accepts a generation.
2. Choose an endpoint from that provider's model documentation, model options as JSON, and an account-wide daily generation-request limit. Image and video models are supported through their asynchronous APIs. For input-media models, include the approved input URL in the owner-controlled options. Agents may supply a prompt, but cannot change the model/options.
3. Enable generation in selected company or project settings. This explicitly permits that scope's editor Work agents to spend your provider credits within the request limit. Company access is inherited by its projects. Disable company access there to remove inheritance.
4. Generate from project settings or ask its Work agent. Track each durable job and refresh its status. Successful results appear as links. Cancel is a request and may be too late to prevent a charge.

Daily caps count submissions, including failed/uncertain submissions, across the account; reset is midnight UTC. They are not dollar caps or output-file caps. Review provider pricing, image count/duration and provider spending limits before enabling agents. A stable request key prevents duplicate Boardly submissions. An interrupted submission is marked uncertain and never automatically recreated. Check the provider dashboard before starting a new job. Disabling/revoking access does not cancel already submitted external jobs.

Provider job URLs are restricted to that provider's API origin, with redirects disabled. Results do not contain provider keys or raw error payloads. Boardly stores project-scoped job records and output links. It does not automatically copy generated media into project storage. Download outputs you want to keep and add them to Files. Provider URLs may be public and expire.

Native Codex Work runs use `scripts/project-media-client.cjs` with `list()`, `generate({provider,prompt,request_key})`, `status({job_id})` and `cancel({job_id})` through a private run-bound broker. Hosted agents use the corresponding `media_*` tools. Current project permissions and active-run state are checked before actions.

References: [fal queue API](https://fal.ai/docs/documentation/model-apis/inference/queue), [Higgsfield API](https://docs.higgsfield.ai/docs), [Higgsfield API specification](https://docs.higgsfield.ai/docs/openapi.json).

## 1Password and ComputerUse

See [1Password setup](onepassword.md). Connect a read-only service account, approve individual login references and exact HTTPS origins, and grant them to selected companies/projects. The model receives no password values; the desktop fills one approved visible field. MFA and CAPTCHA can be handled with human takeover. Existing website sessions/cookies remain until logged out or the desktop is reset.

## Verification

Fixtures exercise separate customer OAuth profiles, absent/revoked account rejection, encrypted provider keys, real Claude/Kimi tool cycles, model discovery, private local HTTP sockets, screenshot conversion, provider continuation, no platform-key usage, async media submit/status/cancel, duplicate and uncertain requests, daily limits, member isolation and native worker broker access. Browser QA covers setup, activation, disconnect, company inheritance and mobile layouts. No real Claude, Kimi, fal or Higgsfield key was supplied during development; no paid generation was used for these tests. Users finish activation with their own accounts in Settings.

## Useful next connectors (recommendations, not included in this release)

| Connector | Suggested Boardly use |
| --- | --- |
| [Google Workspace](https://developers.google.com/workspace/guides/get-started) | Customer-authorized Gmail/Drive/Calendar access for inbox tasks, documents and scheduling. |
| [Slack](https://docs.slack.dev/apis/web-api/) | Send authorized progress updates and let teams review agent handoffs in their own workspace. |
| [Notion](https://developers.notion.com/guides/get-started/overview) | Read approved company knowledge and publish deliverables to selected pages. |
| [PostHog](https://posthog.com/docs/api) | Give product agents access to approved analytics to prioritize and verify improvements. |
| [Resend](https://resend.com/docs/introduction) | Customer-owned transactional email for approved notifications and application workflows; keep marketing campaigns in Mautic. |

These are product recommendations based on the providers' documented APIs. Each would need its own customer authorization, scoped actions and verification before being labeled connected.
