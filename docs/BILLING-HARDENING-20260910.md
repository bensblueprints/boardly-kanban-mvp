# Production billing and connected-computer hardening — 10 September 2026

## Scope and current behavior

Production: https://boardly.onetimesuite.com/app#/account. Full source snapshot:
`C:\Users\DELL\boardly-stripe-20260910`, copied to
`/opt/boardly-clerk/hardening-20260910` on the existing host. This is based on the
exact deployed `chatgpt-722810b` application, not the older local cloud-sync repo.

The live catalog remains $79/month Serial Entrepreneur (5 total users), $299/month
Agency (300 total users), and $9/month per explicitly purchased extra user. Free
includes the owner (1 user). Seat quantity means the total paid add-on quantity,
not a fresh increment on every click. Adding a member never silently purchases a
seat. Complimentary grants never enter Stripe.

General billing portal: invoices, billing details, card updates and cancellation.
Plan and seat updates have separate portal configurations so a seat subscription
cannot be converted to a duplicate base plan. Changes show a confirmation in
Stripe with immediate prorated invoicing/credit; cancellation is at the end of the
paid period. To stop both recurring workspace charges, cancel both subscriptions.
AI is separately funded; platform-card-funded AI remains unavailable without a
platform OpenAI key. This task did not enable it.

Persisted checkout attempts serialize requests per account, reuse an open session,
expire a previous different plan/quantity before opening another, and keep a
stable idempotency key across restart/lost-response retries. Unknown old attempts
fail closed for review rather than risk another charge. A completed checkout that
has not yet produced a visible subscription returns a processing message. Expired
sessions and resubscription after an ended subscription are covered by tests.

Subscription state is still read authoritatively from Stripe. The webhook verifies
the raw signature and timestamp; events do not blindly grant local access.

### Existing downgrade policy — intentionally preserved

`docs/BILLING.md` explicitly retains existing data **and access** on over-limit
accounts, blocking additional users/companies/storage. Downgrades and failed
renewals do not automatically suspend existing member grants. A stricter policy
(which members to pause, grace period, notification) requires the owner's choice.
Do not call this a fully locked-down paid-seat enforcement system without that
decision and its implementation.

### Connected computers

Removed the 25-connection cap for customers' own SSH/Tailscale computers. The owner
can set each saved connection to shared, owner-only, or selected account members
in Account & AI → SSH → Computer sharing & assignment (also on scoped connections).
Selected memberships are checked live; a removed/re-added membership does not
inherit an old assignment. Existing computers remain shared as previously.

Rules are checked on metadata lists, chat context, tests, connection edits/deletes,
worker credential delivery, SSH execution, and GitHub deployments. Generic
company/project SSH scope and Work permissions are still required. Credential
encryption and host-fingerprint verification remain unchanged. Jump credentials
are used only as transport to an authorized destination. These are application
connection permissions, not VM/network isolation or an OS user sandbox. Remote
processes may outlive a revoked SSH connection.

Rented graphical desktops are NOT live. `server/project-computers.js` is still a
preparing/request-only feature; hosted checkout remains disabled. See
`docs/COMPUTER-USE.md` for missing host inventory, capacity, isolation, allocation,
session gateway and retention requirements. Do not sell nonexistent capacity.

## Deployment and recovery

The bad gateway reported by the user matched an origin connection refusal during
the preceding single-container recreation. The app and `/healthz` were otherwise
healthy. A localhost-only Nginx origin now listens on 5318 and forwards to 5317.
Cloudflare's Boardly tunnel points to 5318. HTML failures show a non-cached 503
reconnecting page with a five-second refresh; API error responses are preserved.
The client retries only GET reads on transient gateway/unavailable responses, never
payment writes. This improves restart behavior; it is not zero-downtime HA.

The tunnel was moved using a temporary second registered replica; the original
replica was recreated, registration checked, and the temporary replica removed.
Other applications were not redeployed. Application deploys check that no chat,
discussion or subscription-generation job is active/queued before replacing the
single SQLite writer. During the first rollout, public polling recorded one 503
then returned to 200, with no 502 response.

Production image: `boardly-cloud:hardening-v2-20260910` (final personal billing
status preserves isolation from whichever shared workspace is selected).
Base complete build: `boardly-cloud:hardening-20260910`.
Previous image: `boardly-cloud:complimentary-seats-20260910`.

Private env and original portal/compose/tunnel backups:
`/opt/boardly-clerk/private-backups/billing-hardening-20260910`.
Nine online SQLite backups:
`/opt/boardly-clerk/data/backups/billing-hardening-20260910`.
Do not restore a stale DB just to roll back code. New schema is additive. If rolling
back to the previous app image, restore its portal-update configuration too; the
old code expects the general portal to support update confirmation.

Nginx configuration: `/etc/nginx/conf.d/boardly-origin.conf` (source in `ops/`).
Run `nginx -t` before reloading. No public listener was added. Health of Nginx,
cloudflared and the app must all be monitored; a single host remains a failure
domain. Temporary source archives and sandbox test objects are not customer data.

## Verification performed

- Browser: deployed account and computer-assignment controls visible; live Stripe
  portal opens and Return to Boredly goes to `/app#/account`.
- Live Stripe: charges and payouts enabled; all three paid price checkouts created
  unpaid and immediately expired, without subscriptions or real payments.
- Public webhook: correctly signed request 200; invalid signature 400. Previous
  actual Stripe event delivery also confirmed in the original deployment notes.
- Genuine existing Stripe sandbox: checkout reuse, paid plan activation, upgrade,
  downgrade, seat quantity increase, complimentary seats, paid-period cancellation,
  immediate cancellation returning to Free, and declined payment not activating
  Agency. Sandbox subscriptions cleaned up and test products archived. Portal
  confirmation sessions were created through the application; actual subscription
  changes in this automated test were made by the sandbox API, not by clicking
  every portal confirmation screen. No real card was charged.
- Regression suites passed: billing-lifecycle, billing-checkout-safety,
  complimentary-seats, computer-assignments, ssh-connections, owner-ssh, ssh-broker,
  member-scope-agents, github-broker, ssh-chat-context, member-scopes, cloud.
- Vite production build passed. Runtime npm audit reported zero vulnerabilities;
  build/dev dependencies reported 14 (13 high, 1 critical), which were not blindly
  upgraded as part of this focused production change.
- Justin (`justin@bluejaypro.com`): verified account; 1 included + 2 permanent
  complimentary = 3 total seats; 1 in use; 0 paid seats, 0 subscriptions, no Stripe
  customer, zero Stripe writes by the grant-verification script.

API keys are only in the existing private environment, never committed in this
source. The live secret previously pasted into chat should be rotated through the
Stripe account, then the replacement installed privately with controlled rollout.

## Reference behavior

- [Stripe portal configuration](https://docs.stripe.com/customer-management/configure-portal)
- [Expire a Checkout Session](https://docs.stripe.com/api/checkout/sessions/expire)
- [Stripe sandbox payment methods](https://docs.stripe.com/testing?testing-method=payment-methods)
- [Nginx proxy error handling](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
