const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');

// Dispatch through the complete Express app without opening a network listener.
// The caller supplies the original credentials; authentication runs again.
function internalRequest(app, { method, url, headers, body, prepare, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    req.method = method; req.url = url; req.headers = { ...headers };
    req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    if (payload) req.headers['content-length'] = String(payload.length);
    const res = new ServerResponse(req), chunks = [];
    let bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { req.destroy(); res.destroy(); res.emit('close'); }
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(Error('The API request timed out. Check its saved state before retrying a write.'), { status: 504 })), timeout);
    const collect = (chunk, encoding) => {
      if (!chunk) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) throw Object.assign(Error('Response exceeds 4 MB. Use a narrower query or download the file through the app.'), { status: 413 });
      chunks.push(data);
    };
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, encoding, callback) => {
      try { collect(chunk, encoding); return write(chunk, encoding, callback); }
      catch (error) { finish(error); return false; }
    };
    res.end = (chunk, encoding, callback) => {
      try { collect(chunk, encoding); return end(chunk, encoding, callback); }
      catch (error) { finish(error); return res; }
    };
    res.on('error', error => finish(error));
    res.on('finish', () => {
      const data = Buffer.concat(chunks), contentType = String(res.getHeader('content-type') || '');
      let result;
      try { result = /\bjson\b/i.test(contentType) ? JSON.parse(data.toString() || 'null') : /^text\//i.test(contentType) ? data.toString() : { encoding: 'base64', content: data.toString('base64'), content_type: contentType }; }
      catch { return finish(Error('The API returned invalid JSON')); }
      finish(null, { status: res.statusCode, data: result });
    });
    res.assignSocket(socket);
    prepare?.(req);
    if (payload) req.push(payload);
    req.complete = true;
    req.push(null);
    app.handle(req, res);
  });
}

module.exports = { internalRequest };
