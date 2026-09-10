// Daily entitlement revalidation: asks Whop whether each active/grace
// membership is still valid. Covers missed webhooks. Never throws out of
// the interval — failures are logged and the row is retried next run.

const DAY_MS = 24 * 60 * 60 * 1000;

// One sweep over entitlements due for a check (status active|grace and
// checked_at missing or older than staleMs). Exported for tests.
// Returns {checked, errors}.
async function revalidateOnce(db, whop, opts = {}) {
  const staleMs = opts.staleMs || DAY_MS;
  const graceDays = Number(opts.graceDays || (whop.config && whop.config.graceDays) || 3);
  const now = Date.now();
  const due = db
    .prepare(
      `SELECT e.account_id, e.status, e.grace_ends_at, a.whop_user_id
       FROM entitlements e JOIN accounts a ON a.id = e.account_id
       WHERE e.status IN ('active', 'grace')
         AND a.whop_user_id IS NOT NULL
         AND (e.checked_at IS NULL OR e.checked_at < ?)`
    )
    .all(now - staleMs);

  let errors = 0;
  for (const row of due) {
    try {
      const m = await whop.getActiveMembership(row.whop_user_id);
      const checkedAt = Date.now();
      if (m.valid) {
        db.prepare(
          `UPDATE entitlements SET status = 'active', grace_ends_at = NULL,
             renews_at = ?, checked_at = ? WHERE account_id = ?`
        ).run(m.renewsAt, checkedAt, row.account_id);
      } else if (row.status === 'grace') {
        // Already in grace: keep the original grace_ends_at. Flip to
        // suspended once it has passed.
        if (row.grace_ends_at && row.grace_ends_at <= checkedAt) {
          db.prepare(
            "UPDATE entitlements SET status = 'suspended', checked_at = ? WHERE account_id = ?"
          ).run(checkedAt, row.account_id);
        } else {
          db.prepare('UPDATE entitlements SET checked_at = ? WHERE account_id = ?')
            .run(checkedAt, row.account_id);
        }
      } else {
        // Was active, no longer valid: start the grace window now.
        db.prepare(
          "UPDATE entitlements SET status = 'grace', grace_ends_at = ?, checked_at = ? WHERE account_id = ?"
        ).run(checkedAt + graceDays * DAY_MS, checkedAt, row.account_id);
      }
    } catch (err) {
      // Leave the row untouched (checked_at stays stale) so it is retried
      // on the next sweep.
      errors++;
      console.error(`[revalidate] account ${row.account_id}: ${err.message}`);
    }
  }
  return { checked: due.length, errors };
}

function startRevalidation(db, whop, opts = {}) {
  const intervalMs = opts.intervalMs || DAY_MS;
  const timer = setInterval(() => {
    revalidateOnce(db, whop, opts).catch((err) => {
      // Defensive: revalidateOnce swallows per-row errors already.
      console.error(`[revalidate] sweep failed: ${err.message}`);
    });
  }, intervalMs);
  timer.unref(); // never keep the process alive just for this job
  return timer;
}

module.exports = { revalidateOnce, startRevalidation };
