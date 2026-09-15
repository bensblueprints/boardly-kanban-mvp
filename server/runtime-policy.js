// Shared by the scheduler, worker and connector. Deployments can size capacity
// without changing source; individual conversations and shared writers stay ordered.
function capacity(value = process.env.BOARDLY_MAX_AGENTS, fallback = 4) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : fallback;
}
function failureKind(error) {
  if (error?.code === 'allowance_exhausted' || /usage.limit.reached|usage limit was reached|insufficient_quota|quota.exceeded|credits? exhausted|balance.*insufficient/i.test(error?.message || '')) return 'allowance';
  if (error?.status === 401 || error?.status === 403) return 'access';
  if (error?.retryable === false || /usage needs review|has not been automatically retried|connection changed|access was removed/i.test(error?.message || '')) return 'review';
  return [408,425,429,502,503,504].includes(error?.status) ? 'transient' : 'review';
}
const retryDelay = attempt => Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
module.exports = { capacity, failureKind, retryDelay };
