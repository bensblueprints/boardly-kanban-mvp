// Whop API client for Boardly Cloud Sync billing: OAuth code exchange,
// membership lookup, and webhook signature verification. No SDK — plain
// fetch + crypto. Every URL, event name and header name lives in the
// constants below so ops can adjust without refactoring.
//
// What was verified against official sources (2026-08):
//  - OAuth endpoints https://api.whop.com/oauth/{authorize,token,userinfo}
//    with PKCE (S256) and scopes openid/profile/email:
//    https://whop.com/blog/add-user-authentication/ and
//    https://whop.com/blog/build-patreon-clone/ (raw endpoints, code_verifier
//    + client_secret in the token POST). The official guide
//    (https://docs.whop.com/apps/features/oauth-guide) only shows the SDK.
//  - REST base https://api.whop.com/api/v1 with `Authorization: Bearer
//    <WHOP_API_KEY>`; GET /memberships supports query filters:
//    https://docs.whop.com/api-reference/beta/memberships/list-memberships
//  - Webhooks "follow the Standard Webhooks spec" (webhook-id /
//    webhook-timestamp / webhook-signature headers; the SDK wraps the secret
//    with btoa()): https://docs.whop.com/developer/guides/webhooks
//  - Current event names are membership.activated / membership.deactivated
//    (same docs page); the older API called them membership.went_valid /
//    membership.went_invalid (what our plan names). We accept BOTH.
//
// Assumed (defensive parsing, adjust here if Whop differs):
//  - userinfo returns OIDC claims {sub, email, preferred_username}.
//  - Token endpoint accepts application/x-www-form-urlencoded with
//    grant_type, code, redirect_uri, client_id, client_secret, code_verifier.
//  - Membership list envelope is {data: [...]} (older APIs used
//    {memberships: [...]}); membership validity is `valid === true` OR
//    status in VALID_MEMBERSHIP_STATUSES; renewal time is
//    renewal_period_end (epoch seconds) or current_period_end (ISO 8601).
//  - Legacy webhooks used an `x-whop-signature` hex HMAC-SHA256 of the raw
//    body; supported as a fallback alongside the Standard Webhooks scheme.

const crypto = require('crypto');

// ---- centralized Whop surface (edit here if the API shape changes) ----
const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
const OAUTH_TOKEN_PATH = '/oauth/token';
const OAUTH_USERINFO_PATH = '/oauth/userinfo';
const MEMBERSHIPS_PATH = '/api/v1/memberships';

const OAUTH_SCOPES = ['openid', 'profile', 'email'];

// Membership lifecycle events: current (docs.whop.com) + legacy names.
const EVENTS_WENT_VALID = ['membership.activated', 'membership.went_valid'];
const EVENTS_WENT_INVALID = ['membership.deactivated', 'membership.went_invalid'];

// Standard Webhooks headers (https://www.standardwebhooks.com/).
const HDR_WEBHOOK_ID = 'webhook-id';
const HDR_WEBHOOK_TIMESTAMP = 'webhook-timestamp';
const HDR_WEBHOOK_SIGNATURE = 'webhook-signature';
// Legacy Whop header (plain hex HMAC of the raw body).
const HDR_LEGACY_SIGNATURE = 'x-whop-signature';

const WEBHOOK_TOLERANCE_SEC = 300; // Standard Webhooks default

// Membership statuses we treat as paid-and-usable. Docs show 'trialing';
// older docs used 'active'. Anything else (canceled, expired, past_due,
// unresolved...) counts as invalid.
const VALID_MEMBERSHIP_STATUSES = ['active', 'trialing'];

function envConfig(env) {
  return {
    apiKey: env.WHOP_API_KEY || null,
    webhookSecret: env.WHOP_WEBHOOK_SECRET || null,
    productId: env.WHOP_PRODUCT_ID || null,
    graceDays: Number(env.GRACE_DAYS || 3),
    smtpHost: env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: Number(env.SMTP_PORT || 465),
    smtpUser: env.SMTP_USER || null,
    smtpPass: env.SMTP_PASS || null,
    mailFrom: env.MAIL_FROM || null,
    // Optional, already present in the live env: linked from the portal
    // page when set, never required.
    portalBaseUrl: env.PORTAL_BASE_URL || null,
    checkoutUrl: env.WHOP_CHECKOUT_URL || null,
  };
}

// Whop-side billing: entitlement checks (webhook + revalidation) need the
// API key and the product id. Works without mail (degraded mode: tokens
// are then only retrievable via the dev bootstrap).
function billingEnabled(config) {
  return !!(config && config.apiKey && config.productId);
}

// Token delivery needs SMTP credentials (host/port have Gmail defaults;
// MAIL_FROM falls back to the SMTP user).
function mailEnabled(config) {
  return !!(config && config.smtpUser && config.smtpPass);
}

// Full billing = Whop entitlement checks + email token delivery.
function whopEnabled(config) {
  return billingEnabled(config) && mailEnabled(config);
}

function webhooksEnabled(config) {
  return !!(config && config.webhookSecret);
}

function createWhopClient(config, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const oauthBase = (opts.oauthBase || 'https://api.whop.com').replace(/\/$/, '');
  const apiBase = (opts.apiBase || 'https://api.whop.com').replace(/\/$/, '');

  async function whopFetch(url, init) {
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, ok: res.ok, body, headers: res.headers };
  }

  // URL the portal's "Sign in with Whop" button points at. PKCE is used
  // because Whop's OAuth is an OIDC-style flow (see header comments).
  function getAuthorizationUrl({ redirectUri, state, codeChallenge }) {
    const u = new URL(oauthBase + OAUTH_AUTHORIZE_PATH);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', config.oauthClientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', OAUTH_SCOPES.join(' '));
    u.searchParams.set('state', state);
    if (codeChallenge) {
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    return u.toString();
  }

  // Exchange an authorization code, then resolve the Whop user identity.
  // Returns {whopUserId, email, username}; throws on any upstream failure.
  async function exchangeOAuthCode({ code, redirectUri, codeVerifier }) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
    });
    if (codeVerifier) form.set('code_verifier', codeVerifier);
    const tok = await whopFetch(oauthBase + OAUTH_TOKEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!tok.ok || !tok.body || !tok.body.access_token) {
      throw new Error(`whop token exchange failed (HTTP ${tok.status})`);
    }
    const info = await whopFetch(oauthBase + OAUTH_USERINFO_PATH, {
      headers: { authorization: `Bearer ${tok.body.access_token}` },
    });
    if (!info.ok || !info.body || !info.body.sub) {
      throw new Error(`whop userinfo failed (HTTP ${info.status})`);
    }
    return {
      whopUserId: String(info.body.sub),
      email: info.body.email ? String(info.body.email) : null,
      username: info.body.preferred_username
        ? String(info.body.preferred_username)
        : (info.body.name ? String(info.body.name) : null),
    };
  }

  // Is there a valid membership for this Whop user on our product?
  // Returns {valid, renewsAt(ms epoch)|null}. Throws on upstream failure.
  async function getActiveMembership(whopUserId) {
    const u = new URL(apiBase + MEMBERSHIPS_PATH);
    u.searchParams.set('user_id', whopUserId);
    if (config.productId) u.searchParams.set('product_id', config.productId);
    const res = await whopFetch(u.toString(), {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`whop memberships lookup failed (HTTP ${res.status})`);
    }
    const list = (res.body && (res.body.data || res.body.memberships)) || [];
    // Server-side filter may be ignored by the API; re-check client-side
    // when the product is identifiable on the membership object.
    const m = list.find((x) => {
      if (!config.productId) return true;
      const pid = x.product_id || (x.product && x.product.id) ||
        (x.access_pass && x.access_pass.id) || null;
      return pid === null || pid === config.productId;
    });
    if (!m) return { valid: false, renewsAt: null };
    const valid = m.valid === true ||
      VALID_MEMBERSHIP_STATUSES.includes(String(m.status || '').toLowerCase());
    return { valid, renewsAt: parseWhopTimestamp(m.renewal_period_end ?? m.current_period_end) };
  }

  return {
    config,
    getAuthorizationUrl,
    exchangeOAuthCode,
    getActiveMembership,
  };
}

// Whop timestamps appear as epoch seconds (v1) or ISO 8601 strings (beta).
// Always store epoch ms internally.
function parseWhopTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Verify a webhook signature. Primary: Standard Webhooks scheme — HMAC-
// SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}`, base64,
// compared against `v1,<sig>` entries (Whop's SDK btoa()s the secret, so
// the raw secret string is the HMAC key). Fallback: legacy x-whop-signature
// hex HMAC-SHA256 of the raw body. Timing-safe throughout.
function verifyWebhookSignature(rawBody, headers, secret) {
  if (!secret) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const get = (name) => {
    const v = headers[name] || headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const sigHeader = get(HDR_WEBHOOK_SIGNATURE);
  if (sigHeader) {
    const id = get(HDR_WEBHOOK_ID);
    const ts = Number(get(HDR_WEBHOOK_TIMESTAMP));
    if (!id || !Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > WEBHOOK_TOLERANCE_SEC) {
      return false; // replay window
    }
    const expected = crypto
      .createHmac('sha256', String(secret))
      .update(`${id}.${ts}.`)
      .update(body)
      .digest('base64');
    // Header may carry several space-separated "v1,<sig>" candidates.
    return sigHeader
      .split(' ')
      .filter((p) => p.startsWith('v1,'))
      .some((p) => timingSafeEq(p.slice(3), expected));
  }

  const legacy = get(HDR_LEGACY_SIGNATURE);
  if (legacy) {
    const expected = crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
    return timingSafeEq(legacy, expected);
  }
  return false;
}

// Normalize a Whop webhook payload into {type, whopUserId, renewsAt, email}.
// type is 'went_valid' | 'went_invalid' | 'other'. Accepts both `type`
// (current) and `action` (legacy) envelopes and both event spellings.
function parseWebhookEvent(body) {
  const name = body && (body.type || body.action);
  const data = (body && body.data) || {};
  const whopUserId = data.user_id || data.user_id === 0
    ? String(data.user_id)
    : (data.user && data.user.id ? String(data.user.id) : null);
  const renewsAt = parseWhopTimestamp(data.renewal_period_end ?? data.current_period_end);
  // Buyer email: no single documented location, so try the plausible spots.
  const email = firstString([
    data.email,
    data.user && data.user.email,
    data.member && data.member.email,
    data.membership && data.membership.user && data.membership.user.email,
  ]);
  let type = 'other';
  if (EVENTS_WENT_VALID.includes(name)) type = 'went_valid';
  else if (EVENTS_WENT_INVALID.includes(name)) type = 'went_invalid';
  return { type, whopUserId, renewsAt, email, eventName: name || null };
}

function firstString(candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) return c;
  }
  return null;
}

module.exports = {
  envConfig,
  whopEnabled,
  billingEnabled,
  mailEnabled,
  webhooksEnabled,
  createWhopClient,
  verifyWebhookSignature,
  parseWebhookEvent,
  parseWhopTimestamp,
  VALID_MEMBERSHIP_STATUSES,
};
