const http = require('node:http');

function request(action, data) {
  const socketPath = process.env.BOARDLY_CARD_SOCKET;
  if (!socketPath) throw Error('Card access is not enabled for this project run');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/' + action, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { try { const result = JSON.parse(raw); if (res.statusCode !== 200) reject(Error(result.error || 'Checkout request failed')); else resolve(result); } catch { reject(Error('Invalid checkout response')); } });
    });
    req.setTimeout(65000, () => req.destroy(Error('Checkout request timed out; review the saved hold before retrying')));
    req.on('error', () => reject(Error('Project checkout connection unavailable; review any existing hold before retrying')));
    req.end(JSON.stringify(data));
  });
}

// Do not print, persist, screenshot or return the callback's card object.
// The return value contains only the purchase reference and masked metadata.
async function withCardForCheckout(checkout, fill) {
  const { purchase, card } = await request('reserve', checkout);
  try { await fill(card); }
  catch {
    await request('finish', { purchase_id: purchase.id, status: 'uncertain' }).catch(() => {});
    throw Error('Checkout preparation failed. Its budget remains held until the outcome is reviewed.');
  } finally { card.number = ''; }
  return { purchase_id: purchase.id, last4: purchase.card_last4, amount_minor: purchase.amount_minor, currency: purchase.currency, merchant_origin: purchase.merchant_origin };
}

// Fill an inspected Playwright page without sending the card through model
// messages. This does not submit an order or handle bank/CVV challenges.
async function fillCheckout(page, checkout, selectors) {
  const origin = new URL(checkout.merchant_url).origin;
  const sameMerchant = () => { if (new URL(page.url()).origin !== origin) throw Error('Checkout page changed merchant'); };
  sameMerchant();
  if (!selectors?.number) throw Error('A card-number field is required');
  return withCardForCheckout(checkout, async card => {
    const values = { number: card.number, cardholder: card.cardholder,
      exp_month: String(card.exp_month).padStart(2, '0'), exp_year: String(card.exp_year),
      expiry: `${String(card.exp_month).padStart(2,'0')}/${card.exp_year}`, expiry_short: `${String(card.exp_month).padStart(2,'0')}/${String(card.exp_year).slice(-2)}`,
      ...Object.fromEntries(Object.entries(card.billing).map(([k,v]) => ['billing_' + k, v])) };
    for (const [name, target] of Object.entries(selectors)) {
      sameMerchant();
      if (!Object.hasOwn(values, name)) throw Error('Unsupported payment field');
      let context = page;
      if (typeof target === 'object' && target.frame) {
        const element = await page.locator(target.frame).elementHandle();
        context = await element?.contentFrame();
        if (!context || !target.frame_origin || new URL(context.url()).origin !== target.frame_origin) throw Error('Payment frame origin does not match the inspected checkout');
      }
      const locator = context.locator(typeof target === 'string' ? target : target.selector);
      if (typeof target === 'object' && target.select) await locator.selectOption(values[name]); else await locator.fill(values[name]);
    }
    sameMerchant();
  });
}
const finishCheckout = ({ purchase_id, status, actual_minor }) => request('finish', { purchase_id, status, actual_minor });
module.exports = { withCardForCheckout, fillCheckout, finishCheckout };
