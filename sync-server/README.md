# Boardly sync-server

Central sync service for Boardly Cloud Sync, the $5/month paid add-on sold
through Whop. Multi-tenant Express + SQLite store for opaque entity payloads
and attachment bytes — there is deliberately no endpoint that renders or
aggregates board content.

## Token flow

1. Customer buys the "Boardly Cloud Sync" membership on Whop.
2. Whop fires `membership.went_valid` (a.k.a. `membership.activated`) to our
   webhook. The server upserts the account (by Whop user id + buyer email
   from the event payload), activates the entitlement, mints a `bsk_…`
   token (only its sha256 hash is stored) and **emails the plaintext token
   to the buyer via SMTP**.
3. They paste the token into Boardly → Settings → Sync → Connect. Every
   `/api/*` call is Bearer-token authenticated and gated on the account's
   entitlement being `active` (or `grace` before `grace_ends_at`).
4. Lost the token? `https://<server>/portal` asks for the checkout email
   and mails a fresh token (old tokens are revoked). The answer page is
   always identical — it never reveals whether a membership exists — and
   the endpoint is rate-limited per IP (5 requests / 10 min).

## Entitlement lifecycle

- `POST /webhooks/whop` (signature-verified): `went_valid` activates +
  emails a token; `membership.went_invalid` (a.k.a.
  `membership.deactivated`) starts a `GRACE_DAYS` (default 3) grace window.
  Other events are acknowledged and ignored. Delivery is at-least-once —
  processing is idempotent (a duplicate `went_valid` neither re-mints nor
  re-emails while a live token exists).
- Expired grace rows flip to `suspended` lazily in the auth middleware.
- A daily job (`revalidate.js`, wired in `index.js`) re-checks every
  active/grace entitlement against the Whop API to cover missed webhooks.
- Token emails that can't be delivered (no buyer email in the payload,
  SMTP down, mail not configured) are recorded in the `mail_failures`
  table for ops to replay; the webhook still answers 200.

## Whop + SMTP setup

1. Create a Whop App (Dashboard → Developer) and copy the API key; create
   the "Boardly Cloud Sync" product and copy its product id.
2. Create a webhook pointing at `https://<your-domain>/webhooks/whop` with
   the two membership events; copy the signing secret.
3. Set up a Google Workspace sender for token emails: enable 2FA on the
   account and create an app password at
   https://myaccount.google.com/apppasswords.
4. Set the env vars from `.env.example`.

Degraded mode: with `WHOP_API_KEY` + `WHOP_PRODUCT_ID` set but SMTP
unset, entitlements are still maintained (webhook + revalidation) and the
portal stays offline; tokens are then only retrievable via the dev
bootstrap. With no billing env at all the server still runs: the portal
shows a maintenance message and the webhook route returns 503.

## Dev bootstrap escape hatch

Set `DEV_BOOTSTRAP_KEY` to enable `POST /dev/accounts`, which mints an
account + token without Whop (used by the test suite and local
development). Unset in production.

## Run locally

```sh
npm install
PORT=5400 DATA_DIR=./data node index.js
```

## Tests

```sh
npm test                      # sync-server tests (this directory)
npm run test:sync             # from the repo root: full client+server sync suite
```

`test/whop.test.js` boots a fake Whop (memberships API, webhook signing)
and uses a recording fake mailer plus a mocked nodemailer transport, and
drives webhooks, token emails, the request-token portal, rate limiting,
grace expiry, revalidation, and degraded mode end-to-end.
