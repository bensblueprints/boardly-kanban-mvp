# Boardly Stripe deployment — 2026-09-10

Production: https://boardly.onetimesuite.com/app#/account

Stripe account: `acct_1UDoHGQW5UXyTxU7` (Boredly, live payments enabled).

| Item | Monthly USD | Stripe price |
| --- | ---: | --- |
| Serial Entrepreneur | 79 | `price_1UDtdtQW5UXyTxU7d8ELvZwL` |
| Agency | 299 | `price_1UDtdtQW5UXyTxU71YcJKvm0` |
| Additional user | 9 per user | `price_1UDtdtQW5UXyTxU7m8aj9zCs` |

The existing account plan definitions determined pricing and allowances. Basic Free remains free. Paid plan changes use hosted Stripe confirmation and immediate prorations; cancellation takes effect at the end of the current period. The app reads authoritative subscriptions for each request, including sponsored workspaces. Inactive subscriptions lose paid allowances. Existing over-limit data remains accessible; additions are gated.

Webhook: `https://boardly.onetimesuite.com/api/billing/webhook`, endpoint `we_1UDtduQW5UXyTxU7j45aOZl2`, API version `2025-12-15.clover`.

Subscribed events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`. Signed events are acknowledged; access is computed from live Stripe state, not from event payloads. Duplicate or out-of-order events cannot assign an account plan.

Portal configuration: `bpc_1UDtduQW5UXyTxU7dRVCkuGZ`. The portal allows plan changes, seat quantities, end-of-period cancellation, billing details, payment methods and invoice history. Hosted checkout and portal returns now open `/app#/account`; the earlier `/#/account` opened the marketing page.

The Stripe account already defaulted to Managed Payments. Integration preserves that setting, omits the unsupported `payment_method_types` and `custom_text` Checkout parameters, and classifies the business workspace/seat products as SaaS business use (`txcd_10103001`). Product descriptions state the price/allowance. Stripe determines payment methods and applicable taxes. References: [Managed Payments integration](https://docs.stripe.com/payments/managed-payments/update-checkout), [eligible product codes](https://docs.stripe.com/payments/managed-payments/eligibility).

The existing setup also created its required AI meter/product (`price_1UDtdtQW5UXyTxU7ojGIzlhW`, meter `mtr_61VNHbFezzTzRk3oO41QW5UXyTxU7HRo`). Card-funded AI is NOT enabled: `BOARDLY_OPENAI_API_KEY` is absent. No AI usage or invoice was billed. Do not claim AI payment readiness without separately configuring and validating that workflow.

## Deployment and recovery

Host: SSH alias `hetzner`; root `/opt/boardly-clerk`. Running image: `boardly-cloud:stripe-20260910`, built from the exact prior image `boardly-cloud:chatgpt-722810b` plus `server/customer-billing.js`. Only the web service was recreated; worker, tunnel, audio and ChatGPT services were preserved.

The live secret, publishable key, generated signing secret and identifiers exist only in private `/opt/boardly-clerk/cloud.env` (0600). No secrets are in this source snapshot. The publishable key is stored for future use; the current integration redirects to Stripe-hosted checkout and does not require Stripe.js.

Previous environment and compose are backed up under `/opt/boardly-clerk/private-backups/stripe-20260910` (0700; files 0600). No database migrations or customer subscription mutations were required. Preserve current data if rolling back. To disable billing, restore the previous private environment and compose, then recreate only `boardly`. To rotate the exposed live key, replace `STRIPE_SECRET_KEY` in `cloud.env` and recreate only that service; existing price/webhook IDs remain usable within the same Stripe account.

Patched source and operations scripts: local `C:/Users/DELL/boardly-stripe-20260910`; server `/opt/boardly-clerk/billing-20260910`. The complete local snapshot came from the deployed `chatgpt-722810b` archive, not the outdated desktop checkout. This snapshot has no Git metadata. Carry the billing module, tests and setup changes into the authoritative development branch before a future full image build to avoid overwriting the fix. Do not rerun catalog setup: its Stripe idempotency retention is limited and catalog objects already exist.

## Verification

- Billing lifecycle test passed: basic → serial → agency → serial → cancelled, renewal failure states, seat quantities, account isolation, current paid period cancellation, signed/invalid/stale webhook checks and checkout return URLs.
- Existing personal AI integration tests passed against provider fixtures: account/seat entitlement, encrypted keys, billing outbox and cancellation gates; no real provider calls or charges.
- Stripe accepted live unpaid checkout creation for both plans and an additional user at the exact amounts. All three sessions were immediately expired, with no subscriptions or charges created.
- Production image healthy with zero restarts. `/healthz` and `/app` return HTTP 200.
- Public webhook returns HTTP 200 for a correctly signed synthetic payload and HTTP 400 for an invalid signature.
- Stripe itself delivered live event `evt_1UDtszQW5UXyTxU7NFzJIY8e` to the configured endpoint (`pending_webhooks: 0`). This was a harmless product-metadata update with `product.updated` temporarily subscribed; the original eight payment/subscription event types were restored afterward.
- Runtime verification inside the production container reports billing ready, live credentials loaded, portal and webhook configured, and card-funded AI disabled.

A real completed card payment, resulting subscription update, and renewal invoice have not been exercised. No test-mode key was supplied; fixture tests are not represented as Stripe sandbox payment tests.

## Complimentary users for Justin — 2026-09-10

Applied the account owner's explicit request to `justin@bluejaypro.com` (verified Clerk identity `user_3J6PNoBxx77WwONubxXIrXjJDGK`). Basic Free allowance increased from 1 user to 3 total users: 1 base user plus 2 complimentary users, no expiration. No members were invited because no member email addresses were supplied.

Grant `justin-bluejaypro-two-free-users-20260910` is stored in `personal-ai.db` → `billing_complimentary_seats`. Its unique grant ID makes a retry idempotent. This administrative-only table is independent of Stripe subscriptions. Free seats add to purchased seats and survive their cancellation; no public endpoint can grant them. The existing account settings and membership limits consume the combined allowance. `plan.complimentary_users` and billing state expose the separate complimentary count.

No Stripe customer, subscription, invoice, payment or other Stripe write was created for Justin; he had no Stripe customer or subscription before or after the grant. The admin script prohibits non-GET Stripe requests. Verified the saved record by reopening it after the grant.

Current image: `boardly-cloud:complimentary-seats-20260910`, based on the previous Stripe image, with only the billing module changed. No jobs were running during deployment. Prior compose is in `/opt/boardly-clerk/private-backups/complimentary-seats-20260910/compose.yml`. A consistent database backup before the grant is `/opt/boardly-clerk/data/backups/complimentary-seats-20260910/personal-ai-before-justin.db`. Keep current data if reverting a deployment.

Tests passed for two additional members, blocking a third, persistence, shared-workspace allowance, other-account isolation, coexistence with paid seats, and zero Stripe writes. Existing billing lifecycle regression tests also passed. Operations script: `scripts/complimentary-seats.cjs` (restricted to the requested account and grant).

## Billing portal and connected computers — subsequent 2026-09-10 update

The current production image is now `boardly-cloud:hardening-v2-20260910`.
See [the hardening and verification record](docs/BILLING-HARDENING-20260910.md)
for the stable origin proxy, persistent checkout retry protection, separate plan
and seat update portals, computer sharing/assignment, backups and rollback notes.
The existing Stripe sandbox was available through the authorized account, so real
sandbox subscription lifecycle and declined-payment tests have now passed. No
real card was charged. Justin's permanent grant remains unchanged and was checked
again after the final deployment.

Hosted graphical computers remain request-only, with no hosted-computer checkout.
The existing documented downgrade policy retains over-limit member access and
blocks further additions; stricter suspension is awaiting the owner's decision.
