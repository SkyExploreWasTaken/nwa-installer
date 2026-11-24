// NumPlay builder for the local server: serves NumPlay Studio (Mason363/NumPlay's customize/ page, GPL-3.0) from its
// own site, through this server, with numplay-bridge.js added to its page. Nothing of NumPlay is in this repository:
// its files are fetched when asked for, and kept in .cache/numplay/ to work offline after.
//   /numplay/...       -> https://mason363.github.io/NumPlay/customize/...
//   /docs/media/...    -> https://mason363.github.io/NumPlay/docs/media/...   (the games' clips)
//   /numplay-extra/    -> the extra apps offered in the builder: extra/*.nwa next to server.js
'use strict';
const https = require('https'), fs = require('fs'), path = require('path');

const UPSTREAM = 'https://mason363.github.io/NumPlay/';
const CACHE = path.join(__dirname, '.cache', 'numplay');
const EXTRA = path.join(__dirname, 'extra');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.gz': 'application/gzip' };

function get(url, hops = 0) {
  return new Promise((ok, no) => {
    https.get(url, { headers: { 'User-Agent': 'nwa-installer (local)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        const u = new URL(res.headers.location, url);
        if (!u.href.startsWith(UPSTREAM)) return no(new Error('Redirected away from NumPlay'));
        return get(u.href, hops + 1).then(ok, no);
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(parts) }));
    }).on('error', no).setTimeout(60000, function () { this.destroy(new Error('timed out')); });
  });
}

// the file from NumPlay's site, or the copy kept from last time when that fails
async function fetchCached(rel) {
  const file = path.join(CACHE, rel);
  if (!file.startsWith(CACHE + path.sep)) throw Object.assign(new Error('bad path'), { code: 400 });
  try {
    const r = await get(UPSTREAM + rel.split('/').map(encodeURIComponent).join('/'));
    if (r.status === 200) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, r.body);
      return r.body;
    }
    if (r.status === 404) throw Object.assign(new Error('Not found'), { code: 404 });
  } catch (e) {
    if (e.code === 404 || e.code === 400) throw e;
  }
  if (fs.existsSync(file)) return fs.readFileSync(file);
  throw Object.assign(new Error('NumPlay is not reachable and nothing is kept for ' + rel), { code: 502 });
}

function reply(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

// -> true when it answered the request
module.exports = async function numplay(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  if (p === '/numplay') { res.writeHead(301, { Location: '/numplay/' }); res.end(); return true; }
  let rel = null;
  if (p.startsWith('/numplay/')) rel = 'customize/' + (p.slice(9) || 'index.html');
  else if (p.startsWith('/docs/media/')) rel = p.slice(1);
  if (rel !== null) {
    if (rel.includes('..')) { reply(res, 400, Buffer.from('bad path')); return true; }
    try {
      let body = await fetchCached(rel);
      const type = TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream';
      if (rel === 'customize/index.html') {
        // our additions: back to the installer, our extra apps, and "install on the calculator"
        body = Buffer.from(body.toString('utf8').replace('</body>', '<script src="/numplay-bridge.js"></script>\n</body>'));
      }
      reply(res, 200, body, type);
    } catch (e) {
      reply(res, e.code >= 400 ? e.code : 502, Buffer.from(e.message));
    }
    return true;
  }
  if (p === '/numplay-extra/list.json') {
    const list = fs.existsSync(EXTRA) ? fs.readdirSync(EXTRA).filter((f) => /\.nwa$/i.test(f)) : [];
    reply(res, 200, Buffer.from(JSON.stringify(list)), 'application/json');
    return true;
  }
  const m = /^\/numplay-extra\/([^/]+\.nwa)$/i.exec(p);
  if (m) {
    const f = path.join(EXTRA, m[1]);
    if (!fs.existsSync(f)) { reply(res, 404, Buffer.from('Not found')); return true; }
    reply(res, 200, fs.readFileSync(f), 'application/octet-stream');
    return true;
  }
  return false;
};
