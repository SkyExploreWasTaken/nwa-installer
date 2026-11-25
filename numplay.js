// SPDX-License-Identifier: GPL-3.0-or-later
// NumPlay's files for the page's NumPlay builder (public/lib/numplay.js). NumPlay (Mason363/NumPlay, GPL-3.0) isn't
// part of this repository: its kit, apps.js and pico.js are fetched when the page asks for them, PINNED to the commits
// in numplay-manifest.json (raw.githubusercontent.com/<repo>/<sha>/...), and each file's sha256 must match the
// manifest before it is served or kept. Paths not in the manifest are refused. Copies are kept in .cache/numplay/ so
// the builder works offline after (and re-checked against the manifest when read).
//   /numplay/kit/...      -> <manifest sources['kit/']>...
//   /numplay/apps.js      -> <manifest sources['apps.js']>
//   /numplay/pico.js      -> <manifest sources['pico.js']>
//   /numplay/extra/       -> more games for the builder: the .nwa apps in extra/ next to server.js
// To move to a newer NumPlay: node tools/make-numplay-manifest.mjs <kit-sha> <main-sha>
'use strict';
const https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const MANIFEST = JSON.parse(fs.readFileSync(process.env.NUMPLAY_MANIFEST || path.join(__dirname, 'numplay-manifest.json'), 'utf8'));
const CACHE = process.env.NUMPLAY_CACHE || path.join(__dirname, '.cache', 'numplay');
const EXTRA = path.join(__dirname, 'extra');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.gz': 'application/gzip' };
const RETRIES = 3;  // (the network can be flaky)

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// where the manifest says rel comes from
const sourceOf = (rel) => rel.startsWith('kit/')
  ? MANIFEST.sources['kit/'] + rel.slice(4).split('/').map(encodeURIComponent).join('/') : MANIFEST.sources[rel];
const ORIGIN = 'https://raw.githubusercontent.com/';

// (tests replace this to avoid the network) -> { status, body }
let fetcher = function get(url, hops = 0) {
  return new Promise((ok, no) => {
    https.get(url, { headers: { 'User-Agent': 'nwa-installer (local)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        if (!next.startsWith(ORIGIN)) return no(new Error('Redirected away from NumPlay'));
        return get(next, hops + 1).then(ok, no);
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(parts) }));
    }).on('error', no).setTimeout(60000, function () { this.destroy(new Error('timed out')); });
  });
}

const pinnedError = (rel) => Object.assign(new Error("NumPlay's ' + rel + ' does not match its pinned sha256 (refused)"),
  { i18n: { code: 'numplay.hash', params: { file: rel } } });

// a file of NumPlay at the pinned commit: the kept copy when it still matches the manifest, else fetched and checked
async function numplayFile(rel) {
  const want = MANIFEST.files[rel];
  if (!want) return null;  // not in the allowlist
  const file = path.join(CACHE, rel);
  if (fs.existsSync(file)) {
    const kept = fs.readFileSync(file);
    if (sha256(kept) === want.sha256) return kept;
  }
  let lastErr = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const r = await fetcher(sourceOf(rel));
      if (r.status === 404) return null;
      if (r.status === 200) {
        if (sha256(r.body) !== want.sha256) throw pinnedError(rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, r.body);
        return r.body;
      }
    } catch (e) { if (e.i18n?.code === 'numplay.hash') throw e; lastErr = e; /* try again */ }
  }
  throw Object.assign(new Error("NumPlay's files are not reachable and no verified copy of " + rel + ' is kept' + (lastErr ? ' (' + lastErr.message + ')' : '')), { i18n: { code: 'numplay.offline', params: { file: rel } } });
}

// an error for the page: the English message with a code it can say in its language (err.<code> in public/i18n/)
const replyError = (res, status, message, code, params = {}) =>
  reply(res, status, JSON.stringify({ error: message, code, params }), 'application/json');

function reply(res, status, body, type = 'text/plain; charset=utf-8') {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-cache' });
  res.end(b);
}

// -> true when it answered the request
async function numplay(req, res, url) {
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
  } else if (Object.prototype.hasOwnProperty.call(MANIFEST.files, rel)) {  // (the allowlist: only the manifest's paths)
    try {
      const body = await numplayFile(rel);
      if (!body) reply(res, 404, 'Not found');
      else reply(res, 200, body, TYPES[path.extname(rel)] || 'application/octet-stream');
    } catch (e) {
      replyError(res, 502, e.message, e.i18n?.code || 'numplay.fetch', e.i18n?.params || { msg: e.message });
    }
  } else {
    reply(res, 404, 'Not found');
  }
  return true;
}
module.exports = numplay;
module.exports.setFetcher = (f) => { fetcher = f; };  // (for tests)
module.exports.MANIFEST = MANIFEST;
