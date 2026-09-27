const dns = require('node:dns/promises');
const https = require('node:https');
const ipaddr = require('ipaddr.js');
const fail = (status, message) => Object.assign(Error(message), {status});
function baseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail(400, 'Enter your Open WebUI HTTPS server URL.'); }
  if (typeof value !== 'string' || value.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[%\\]/.test(value))
    throw fail(400, 'Use an HTTPS server URL without credentials, query parameters or fragments.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '') || '/';
  if (/\/(playground|chat|models)$/.test(url.pathname)) throw fail(400, 'Enter the Open WebUI server URL, without the playground or chat page.');
  return url.href.replace(/\/$/, '');
}
function publicAddress(address) {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}
// Resolve every request, reject mixed private/public answers, and pin the socket
// lookup to the validated address. TLS still verifies the original hostname.
function createOpenWebUIRequest({resolve=dns.lookup, request=https.request}={}) {
  return async function openWebUIRequest(connection, path, body) {
    const base = baseURL(connection.base_url);
    const url = new URL(base + path);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let timer;
    const timeout = body ? 180000 : 15000;
    const controller = new AbortController();
    try {
      const addresses = await Promise.race([
        resolve(hostname, {all:true}),
        new Promise((_, reject) => { timer=setTimeout(()=>{controller.abort();reject(fail(504, 'Open WebUI timed out.'));}, timeout); }),
      ]);
      if (!addresses.length || addresses.some(a=>!publicAddress(a.address)))
        throw fail(400, 'Use a public HTTPS Open WebUI server. For private computers, use the Local AI connector.');
      const address = addresses.find(a=>a.family===4) || addresses[0];
      return await new Promise((resolveResponse, reject) => {
        const req = request(url, {
          method: body ? 'POST' : 'GET', agent:false, signal:controller.signal,
          lookup: (_host, options, callback) => options.all ? callback(null,[address]) : callback(null,address.address,address.family),
          headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':'Boardly/1.0',Authorization:'Bearer '+connection.token},
        }, res => {
          if (res.statusCode>=300 && res.statusCode<400) { res.destroy();reject(fail(400, 'Open WebUI redirected the request. Enter its final HTTPS server URL.'));return; }
          let size=0;const parts=[];
          res.on('data', chunk=>{size+=chunk.length;if(size>6000000)req.destroy(Error('Response too large'));else parts.push(chunk);});
          res.on('error', ()=>reject(fail(502, 'Open WebUI interrupted the response.')));
          res.on('end', ()=>resolveResponse(new Response(Buffer.concat(parts),{status:res.statusCode})));
        });
        req.on('error', ()=>reject(fail(controller.signal.aborted?504:502, 'Open WebUI could not complete the connection. Check its address, TLS certificate and availability.')));
        req.end(body ? JSON.stringify(body) : undefined);
      });
    } finally { clearTimeout(timer); }
  };
}
module.exports={baseURL,publicAddress,createOpenWebUIRequest};
