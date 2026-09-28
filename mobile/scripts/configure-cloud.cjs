const fs = require('node:fs');
(async () => {
  const origin = 'https://boardlyagent.com';
  const response = await fetch(origin + '/api/auth-config');
  if (!response.ok) throw new Error('Could not read Boardly public authentication configuration');
  const config = await response.json();
  if (!/^pk_(live|test)_/.test(config.publishableKey)) throw new Error('Invalid publishable key');
  fs.writeFileSync('.env.local', 'EXPO_PUBLIC_BOARDLY_ORIGIN=' + origin + '\nEXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=' + config.publishableKey + '\n', { mode: 0o600 });
  console.log('Configured the public Boardly origin and Clerk publishable key.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
