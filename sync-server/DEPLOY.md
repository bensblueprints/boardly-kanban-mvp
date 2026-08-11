# Deploying the Boardly sync-server

Everything runs from this directory. The service stores per-account opaque
entity payloads + attachment blobs in a named volume — there is intentionally
no web UI for board content anywhere.

## 1. Server prep

- VPS with Docker + the compose plugin installed
- DNS **A record** for your sync domain (e.g. `sync.boardly.app`) → server IP
- Ports 80 + 443 open (Caddy handles TLS via Let's Encrypt automatically)

## 2. Whop + SMTP setup (one time)

1. Create the product in Whop: "Boardly Cloud Sync", $5/month.
2. Whop Dashboard → Developer: create/copy the **API key** for your app and
   the **product id** of the new product.
3. Create a webhook pointing at `https://<your-domain>/webhooks/whop`,
   subscribe to membership activation/deactivation events, copy the
   **webhook signing secret**.
4. Google Workspace SMTP: enable 2FA on the sender account
   (e.g. `sync@onetimesuite.com`) and create an **app password** at
   https://myaccount.google.com/apppasswords.

## 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

- `WHOP_API_KEY`, `WHOP_PRODUCT_ID`
- `SMTP_USER`, `SMTP_PASS` (Google Workspace app password), `MAIL_FROM` —
  token email delivery; `SMTP_HOST`/`SMTP_PORT` default to Gmail (`smtp.gmail.com:465`)
- `WHOP_WEBHOOK_SECRET` (recommended)
- `WHOP_CHECKOUT_URL` (optional — linked from the portal page when set)
- Leave `DEV_BOOTSTRAP_KEY` unset in production (it mints tokens without billing).

Without the SMTP vars the server runs in degraded mode: entitlements are
still maintained via webhooks + daily revalidation, but no token emails go
out (failures are recorded in the `mail_failures` table for replay).

## 4. Run

```bash
DOMAIN=sync.boardly.app docker compose up -d --build
curl https://sync.boardly.app/healthz   # {"ok":true}
```

## 5. Point the desktop app at it

The Boardly client's default server URL lives in
`client/src/components/SyncPanel.jsx` (`DEFAULT_SYNC_SERVER_URL`, currently
`https://boardly-api.onetimesuite.com`). Set it to your domain **before** building the
installer (`npm run dist`), or users can edit the URL in the app's
Settings → Sync panel manually.

## Customer flow (what you're selling)

1. Customer buys "Boardly Cloud Sync" on Whop ($5/mo).
2. Whop notifies our webhook; the server activates their entitlement and
   **emails their API token** to the checkout email address (once — store
   it like a password).
3. They paste the token into Boardly desktop → Settings → Sync → Connect.
   Works on unlimited computers with the same token.
4. Lost token? They visit `https://<your-domain>/portal`, enter their
   checkout email, and a fresh token is mailed (the old one is revoked).
5. Cancellation/payment failure → Whop webhook flips them to a grace period
   (`GRACE_DAYS`, default 3) → then sync pauses. Their local data is never
   touched; resubscribing resumes sync (boards re-converge on next sync).

## Ops

- Data: named volume `sync-data` (`sync.db` + `blobs/`). Back it up with
  `docker run --rm -v sync-server_sync-data:/data -v $PWD:/backup alpine tar czf /backup/sync-data.tgz /data`.
- Logs: `docker compose logs -f sync-server`
- Upgrade: `git pull && DOMAIN=... docker compose up -d --build`
- Entitlements are refreshed two ways: webhooks (instant) and a daily
  revalidation sweep against the Whop API (covers missed webhooks).
- Undelivered token emails (SMTP down, no buyer email in the webhook
  payload, mail not configured) are recorded in the `mail_failures` table —
  check it when a customer says no email arrived; the customer can always
  self-serve via `/portal` once mail is back.
