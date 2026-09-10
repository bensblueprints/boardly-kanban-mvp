const SCOPE_CATALOG = [
  { id: 'ssh', name: 'SSH', description: 'Manage SSH connections and let their Work agents use enabled servers.' },
  { id: 'github', name: 'GitHub', description: 'Manage repositories and let their Work agents read and push using enabled connections.' },
  { id: 'environment', name: 'Environment', description: 'Add, replace and remove project environment variables. Saved values stay hidden.' },
  { id: 'payments', name: 'Payment connections', description: 'Manage saved project payment cards and billing details. Budgets and purchases stay with the owner.' },
  { id: 'members', name: 'Members', description: 'Add and manage ordinary members within their access. Only the owner can grant extra scopes.' },
];
const SCOPE_IDS = SCOPE_CATALOG.map(scope => scope.id);
function validateScopes(value) {
  if (!Array.isArray(value) || value.some(scope => !SCOPE_IDS.includes(scope))) {
    throw Object.assign(Error('Choose only the supported member permission scopes'), { status: 400 });
  }
  return SCOPE_IDS.filter(scope => value.includes(scope));
}
function readScopes(value) {
  try { return validateScopes(typeof value === 'string' ? JSON.parse(value) : value || []); }
  catch { return []; }
}
module.exports = { SCOPE_CATALOG, SCOPE_IDS, validateScopes, readScopes };
