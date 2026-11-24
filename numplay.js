// SPDX-License-Identifier: GPL-3.0-or-later
// NumPlay's files for the page's NumPlay builder (public/lib/numplay.js). NumPlay (Mason363/NumPlay, GPL-3.0) isn't
// part of this repository: its kit and apps.js are fetched from NumPlay's site when the page asks for them, and kept
// in .cache/numplay/ so the builder works offline after.
//   /numplay/kit/...      -> https://mason363.github.io/NumPlay/customize/kit/...
//   /numplay/apps.js      -> https://mason363.github.io/NumPlay/customize/apps.js
//   /numplay/extra/       -> more games for the builder: the .nwa apps in extra/ next to server.js
'use strict';
const https = require('https'), fs = require('fs'), path = require('path');

const UPSTREAM = 'https://mason363.github.io/NumPlay/customize/';
const CACHE = path.join(__dirname, '.cache', 'numplay');
const EXTRA = path.join(__dirname, 'extra');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.gz': 'application/gzip' };
const RETRIES = 3;  // (the network can be flaky)

function get(url, hops = 0) {
  return new Promise((ok, no) => {
    https.get(url, { headers: { 'User-Agent': 'nwa-installer (local)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        if (!next.startsWith(UPSTREAM)) return no(new Error('Redirected away from NumPlay'));
        return get(next, hops + 1).then(ok, no);
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(parts) }));
    }).on('error', no).setTimeout(60000, function () { this.destroy(new Error('timed out')); });
  });
}

// a file of NumPlay's site, fresh when it's reachable, else the copy kept from last time
async function numplayFile(rel) {
  const file = path.join(CACHE, rel);
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const r = await get(UPSTREAM + rel.split('/').map(encodeURIComponent).join('/'));
      if (r.status === 404) return null;
      if (r.status === 200) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, r.body);
        return r.body;
      }
    } catch (e) { /* try again, then fall back on the kept copy */ }
  }
  if (fs.existsSync(file)) return fs.readFileSync(file);
  throw new Error('NumPlay\'s site is not reachable and no copy of ' + rel + ' is kept');
}

function reply(res, status, body, type = 'text/plain; charset=utf-8') {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-cache' });
  res.end(b);
}

// -> true when it answered the request
module.exports = async function numplay(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  if (!p.startsWith('/numplay/')) return false;
  const rel = p.slice('/numplay/'.length);

  if (rel === 'extra/') {
    const list = fs.existsSync(EXTRA) ? fs.readdirSync(EXTRA).filter((f) => /\.nwa$/i.test(f)) : [];
    reply(res, 200, JSON.stringify(list), 'application/json');
  } else if (rel.startsWith('extra/')) {
    const name = rel.slice('extra/'.length);
    const file = path.join(EXTRA, name);
    if (!/^[^/\\]+\.nwa$/i.test(name) || !fs.existsSync(file)) reply(res, 404, 'Not found');
    else reply(res, 200, fs.readFileSync(file), 'application/octet-stream');
  } else if ((rel === 'apps.js' || rel.startsWith('kit/')) && !rel.includes('..')) {
    try {
      const body = await numplayFile(rel);
      if (!body) reply(res, 404, 'Not found');
      else reply(res, 200, body, TYPES[path.extname(rel)] || 'application/octet-stream');
    } catch (e) {
      reply(res, 502, e.message);
    }
  } else {
    reply(res, 404, 'Not found');
  }
  return true;
};
