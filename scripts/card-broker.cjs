const http = require('node:http');
const fs = require('node:fs');
const { safeText } = require('../server/agent-activity');

// Only the worker holds the cloud credential. The per-run Unix socket grants
// checkout access to that run's project, not access to other worker endpoints.
async function createCardBroker({ socketPath, request, onCard = () => {}, onActivity = () => {} }) {
  const open = new Set();
  const server = http.createServer(async (req, res) => {
    req.setTimeout(65000, () => req.destroy());
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    if (req.method !== 'POST' || !['/reserve','/finish'].includes(req.url)) { res.writeHead(404); res.end('{"error":"Unknown checkout action"}'); return; }
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16000) throw Object.assign(Error('Checkout request is too large'), { status: 413 }); }
      let data; try { data = JSON.parse(raw); } catch { throw Object.assign(Error('Invalid checkout request'), { status: 400 }); }
      const result = await request(req.url.slice(1), data);
      if (req.url === '/reserve') {
        onCard(result.card); open.add(result.purchase.id);
        onActivity(result.purchase, 'Checkout budget reserved');
      } else {
        if (result.status !== 'reserved') open.delete(result.id);
        onActivity(result, result.status === 'paid' ? 'Checkout reported paid' : result.status === 'released' ? 'Checkout reported no charge' : 'Checkout needs review');
      }
      res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(error.status || 502); res.end(JSON.stringify({ error: safeText(error.message || 'Checkout request failed') })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return {
    socketPath,
    async close() {
      await new Promise(resolve => server.close(resolve));
      // A missing result is never treated as proof that no charge occurred.
      for (const purchase_id of open) {
        try { const result = await request('finish', { purchase_id, status: 'uncertain' }); onActivity(result, 'Checkout needs review'); } catch { /* The persisted reservation still holds its budget. */ }
      }
      fs.rmSync(socketPath, { force: true });
    },
  };
}
module.exports = { createCardBroker };
