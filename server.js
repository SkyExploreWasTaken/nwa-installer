// SPDX-License-Identifier: GPL-3.0-or-later
// The installer's local web server, for this computer only (http://localhost:8642):
//  - the page, from public/
//  - NumWorks' official firmware at /api/firmware/ (numworks.js), fetched with your my.numworks.com account kept in
//    numworks-account.json (see README): the account never goes to the page, only the firmware does
//  - the NumPlay builder at /numplay/ (numplay.js)
//   node server.js [port]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const numplay = require('./numplay.js');    // the NumPlay builder at /numplay/
const numworks = require('./numworks.js');  // NumWorks' firmware at /api/firmware/

const PORT = +(process.argv[2] || process.env.PORT || 8642);
// host names the server answers to besides localhost, e.g. behind a reverse proxy with https (WebUSB needs a secure
// context: localhost or https). ALLOWED_HOSTS=nwainstaller.example.com,other.example.com
const ALLOWED_HOSTS = ['localhost', '127.0.0.1',
  ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
const ROOT = path.join(__dirname, 'public');  // the page
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.o': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.nwa': 'application/octet-stream' };
// never served, even if they end up in public/
const PRIVATE = /(^|\/)(numworks-account\.json|node_modules|\.git)(\/|$)/i;

// on every response. The page has no inline scripts or styles (styles set from JS go through the CSSOM, which CSP allows);
// the linker (vendor/ld.wasm, objcopy.wasm) needs 'wasm-unsafe-eval' to compile WebAssembly.
const CSP = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' blob: data:",
  "connect-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const SECURITY_HEADERS = { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer' };

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
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // the page and its API answer only to this computer, and only to pages from this server
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.includes(host.replace(/:\d+$/, ''))) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') { res.writeHead(403); return res.end(); }
      if (url.pathname === '/api/status') return send(res, 200, numworks.status());
      if (await numworks.handle(req, res, url, send)) return;
      return send(res, 404, { error: 'No such API', code: 'server.noApi', params: {} });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (await numplay(req, res, url)) return;
    serveFile(req, res, url.pathname);
  } catch (e) {
    // (an HttpError carries its status and, for the page, { code, params }; logs and error stay English)
    send(res, e.status >= 400 ? e.status : 502, { error: e.message, ...e.i18n });
  }
});
server.listen(PORT, '127.0.0.1', () => {
  // NumWorks' firmware: checked now and then every hour (NWA_FW_SCHEDULE=0 turns the timer off, for tests)
  if (process.env.NWA_FW_SCHEDULE !== '0') numworks.start();
  console.log(`NWA Installer on http://localhost:${PORT}/  (firmware updates: ${numworks.status().account ? 'NumWorks account found' : 'no numworks-account.json'})`);
});
