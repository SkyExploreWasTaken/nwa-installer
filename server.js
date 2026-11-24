// The installer's local web server: serves the page on http://localhost:8642 (localhost only), and fetches
// NumWorks' official firmware for the page with your my.numworks.com session, kept in a file on this computer
// (numworks-cookie.txt, see README). The cookie never goes to the page: only the firmware does.
//   node server.js [port]
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');

const PORT = +(process.argv[2] || process.env.PORT || 8642);
const ROOT = __dirname;
const COOKIE_FILE = path.join(ROOT, 'numworks-cookie.txt');
const NW = 'https://my.numworks.com';
const MODELS = new Set(['N0100', 'N0110', 'N0115', 'N0120']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.o': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.nwa': 'application/octet-stream' };
// never served: the cookie, and what isn't the page
const PRIVATE = /(^|\/)(numworks-cookie\.txt|node_modules|\.git)(\/|$)/i;

function cookie() {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  // the file holds the Cookie header's value, or just the session cookie (name=value); comments with #
  const c = fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('; ');
  return c.replace(/^cookie:\s*/i, '') || null;
}

// GET from my.numworks.com with the cookie, following redirects there; resolves { status, headers, body: Buffer }
function nwGet(p, accept, hops = 0) {
  return new Promise((ok, no) => {
    const c = cookie();
    if (!c) return no(Object.assign(new Error('No numworks-cookie.txt next to server.js (see README)'), { code: 412 }));
    const req = https.get(NW + p, { headers: { Cookie: c, Accept: accept || '*/*', 'User-Agent': 'nwa-installer (local)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        const u = new URL(res.headers.location, NW);
        if (u.origin !== NW) return no(new Error('Redirected away from my.numworks.com'));
        if (/sign_in/.test(u.pathname)) return no(Object.assign(new Error('The NumWorks session in numworks-cookie.txt has expired: sign in again and copy a new cookie'), { code: 401 }));
        return nwGet(u.pathname + u.search, accept, hops + 1).then(ok, no);
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', no);
    req.setTimeout(60000, () => req.destroy(new Error('my.numworks.com timed out')));
  });
}

// the version NumWorks' updater page offers now: its `flash` setting, in the page's HTML
async function latestVersion() {
  const r = await nwGet('/devices/upgrade', 'text/html');
  if (r.status !== 200) throw new Error('my.numworks.com/devices/upgrade: HTTP ' + r.status);
  const html = r.body.toString('utf8').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const m = /[\s:"']flash["']?\s*[=:]\s*["']*([0-9A-Za-z._-]+)/.exec(html);
  if (!m) throw new Error('Could not find the firmware version on my.numworks.com/devices/upgrade');
  return m[1];
}

async function firmware(req, res, model, ext, version) {
  if (!MODELS.has(model)) return send(res, 400, { error: 'Unknown model ' + model });
  if (version && !/^[0-9A-Za-z._-]{1,40}$/.test(version)) return send(res, 400, { error: 'Bad version' });
  const v = version || await latestVersion();
  const r = await nwGet(`/firmwares/${model}/${encodeURIComponent(v)}.${ext}`, ext === 'json' ? 'application/json' : 'application/octet-stream');
  if (r.status !== 200) return send(res, r.status === 404 ? 404 : 502, { error: `my.numworks.com: HTTP ${r.status} for ${model} ${v}.${ext}` });
  if (ext === 'json') {
    let info;
    try { info = JSON.parse(r.body.toString('utf8')); } catch (e) { return send(res, 502, { error: 'my.numworks.com sent something that is not JSON (session expired?)' }); }
    return send(res, 200, { name: v, ...info });
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': r.body.length, 'Cache-Control': 'no-store',
    'X-Firmware-Name': v });
  res.end(r.body);
}

function send(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

function serveFile(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  if (PRIVATE.test(rel)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  // the page and its API answer only to this computer, and only to pages from this server
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') return send(res, 200, { cookie: !!cookie() });
    const m = /^\/api\/firmware\/(N\d{4})\.(json|dfu)$/.exec(url.pathname);
    if (m) {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') { res.writeHead(403); return res.end(); }
      return await firmware(req, res, m[1], m[2], url.searchParams.get('version'));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveFile(req, res, url.pathname);
  } catch (e) {
    send(res, e.code >= 400 ? e.code : 502, { error: e.message });
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`NWA Installer on http://localhost:${PORT}/  (firmware updates: ${cookie() ? 'NumWorks cookie found' : 'no numworks-cookie.txt'})`);
});
