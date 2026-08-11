// Cloud Sync routes, mounted under the same requireAuth umbrella as every
// other /api route. Thin wrappers around the sync engine — the Settings UI
// polls /api/sync/status and drives the rest from there.

function mountSyncRoutes(app, requireAuth, { engine }) {
  app.get('/api/sync/status', requireAuth, (req, res) => {
    res.json(engine.status());
  });

  app.post('/api/sync/config', requireAuth, async (req, res) => {
    const serverUrl = String(req.body?.serverUrl || '').trim();
    const token = String(req.body?.token || '').trim();
    let parsed;
    try {
      parsed = new URL(serverUrl);
    } catch {
      return res.status(400).json({ error: 'Server URL is not a valid URL' });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(400).json({ error: 'Server URL must be http or https' });
    }
    if (!token) return res.status(400).json({ error: 'Token is required' });

    engine.configure({ serverUrl, token });
    // Kick an immediate round so the response can already carry account info
    // (or the subscription_inactive message) for the UI to show.
    await engine.syncNow();
    res.json(engine.status());
  });

  app.post('/api/sync/disable', requireAuth, (req, res) => {
    engine.disable();
    res.json(engine.status());
  });

  app.post('/api/sync/now', requireAuth, async (req, res) => {
    await engine.syncNow();
    res.json(engine.status());
  });
}

module.exports = { mountSyncRoutes };
