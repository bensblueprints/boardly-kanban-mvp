# Open WebUI connector — 2026-09-27

Account Settings → Open WebUI accepts a public HTTPS server URL and that account's API key. Verify lists `/api/models`; choose a tool-capable model, save, and select **Use for Boardly agents**. Agent requests use `/api/chat/completions` with caller-provided tools and non-streaming responses. Existing Boardly project permissions and tool approvals still apply. Model compatibility varies; successful model discovery alone does not prove tool calling.

Keys use the existing AES-GCM per-account credential store and are never returned to the UI or passed to agent tools. A server URL change requires a new key entry. The transport resolves and validates public addresses, pins DNS for the request, verifies TLS and refuses redirects. Private model hosts remain available through the separate Tailscale Local AI connector.

An active paid subscription is required to save, activate, authorize or receive an Open WebUI response. The platform owner is exempt. Existing Stripe customers qualify through configured active Boardly plans or recurring add-ons. Future voice price IDs can be set with STRIPE_VOICE_STARTER_PRICE_ID, STRIPE_VOICE_PLUS_PRICE_ID and STRIPE_VOICE_PRO_PRICE_ID; this does not create voice products or subscriptions. Deployments without Stripe use verified active Clerk Serial Entrepreneur/Agency subscriptions. Free, trialing, past-due, canceled and expired subscriptions do not qualify. Cancel-at-period-end retains access for its remaining paid period. Disconnect remains available after entitlement expiry. No platform model/key fallback or AI usage markup is introduced.

Validation: `npm run test:openwebui`, `node test/openwebui-browser.cjs`, existing provider, billing, personal AI, owner funding and cloud tests, and `npm run build`. The live owner Open WebUI server passed HTTPS model discovery and a Qwen3 Coder Next tool-call/result round trip. Credentials and test payloads containing credentials are not included here.

Official API reference: https://docs.openwebui.com/reference/api-endpoints/

Deployment layers the changed server files and built client on the current production image with Dockerfile.openwebui. Existing worker and companion services do not require changes. Rollback uses the previous `boardly-cloud:mcp-access-7189b2c` app image; no schema migration is required.
