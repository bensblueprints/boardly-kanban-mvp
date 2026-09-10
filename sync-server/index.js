const { createApp } = require('./app');
const { openDb } = require('./db');
const whoplib = require('./whop');
const { startRevalidation } = require('./revalidate');

const dataDir = process.env.DATA_DIR || './data';
const port = Number(process.env.PORT || 5400);

createApp({ dataDir }).listen(port, () => {
  console.log(`boardly-sync-server listening on :${port}`);
});

// Daily entitlement revalidation against the Whop API (covers missed
// webhooks). Wired here, not in createApp, so tests stay deterministic.
// Opens its own connection to the same SQLite file — WAL mode allows it.
const whopConfig = whoplib.envConfig(process.env);
if (whoplib.billingEnabled(whopConfig)) {
  const whop = whoplib.createWhopClient(whopConfig);
  startRevalidation(openDb(dataDir), whop);
} else {
  console.log('whop billing not configured; entitlement revalidation disabled');
}
