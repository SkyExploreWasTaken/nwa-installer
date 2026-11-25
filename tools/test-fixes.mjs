// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the review fixes and the firmware cache, with no network at all (pretend NumWorks and NumPlay):
//  - storage: UTF-8 names survive a round trip (café.py stays café.py); records over 64 KB and overfull storage refused
//  - the firmware version offered by default: the calculator's own when it's kept, else the latest
//  - firmware-cache.js: checks once at start and then every hour; requests only read the cache; falls back to the kept
//    copies when NumWorks can't be reached; caches a model from the first time it's recognized; never overwrites
//  - numplay.js: only the manifest's paths, only bytes matching their pinned sha256
//  - server.js: security headers on every response; /api/firmware answers from the cache without any network
//   node tools/test-fixes.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwa-fixes-'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ storage
const { parseStorage, buildStorage, MAX_RECORD } = await import('../public/lib/storage.js');

test('storage: café.py keeps its name over a round trip', () => {
  const files = [{ name: 'café.py', content: new TextEncoder().encode('print("é")\n') }, { name: 'ünï.py', content: new Uint8Array([1, 2]) }];
  let img = buildStorage(files, 4096);
  for (let n = 0; n < 3; n++) img = buildStorage(parseStorage(img).files, 4096);  // as "Keep my Python scripts" does, again and again
  const back = parseStorage(img).files;
  assert.deepEqual(back.map((f) => f.name), ['café.py', 'ünï.py']);
  assert.deepEqual([...back[0].content], [...files[0].content]);
});

test('storage: a file over 64 KB is refused, not truncated', () => {
  const big = { name: 'big.py', content: new Uint8Array(MAX_RECORD) };
  assert.throws(() => buildStorage([big], 200000), (e) => e.code === 'storage.tooBig' && e.params.file === 'big.py' && e.params.size > MAX_RECORD);
  const justFits = { name: 'a.py', content: new Uint8Array(MAX_RECORD - 2 - 4 - 1) };
  const back = parseStorage(buildStorage([justFits], 70000)).files;
  assert.equal(back[0].content.length, justFits.content.length, 'the largest record that fits is kept whole');
});

test('storage: files that do not all fit are refused', () => {
  const f = (n) => ({ name: n + '.py', content: new Uint8Array(3000) });
  assert.throws(() => buildStorage([f('a'), f('b'), f('c')], 8192), (e) => e.code === 'storage.full');
});

// ------------------------------------------------------------------ which version is offered
const { firmwareChoices } = await import('../public/lib/fwchoice.js');
const offer = { version: '24.4.0', patch_level: 'p244', size: 3,
  versions: [{ version: '24.4.0', patch_level: 'p244', size: 3 }, { version: '23.2.6', patch_level: 'p236', size: 2 }, { version: '22.2.0', patch_level: 'p220', size: 1 }] };

test('version: the calculator\'s own version is the default when it is kept', () => {
  const c = firmwareChoices(offer, { version: '22.2.0', patch: 'p220' });
  assert.equal(c.selected, '22.2.0');
  assert.deepEqual(c.options.map((o) => [o.version, o.kind]), [['22.2.0', 'current'], ['24.4.0', 'latest'], ['23.2.6', 'cached']], 'current first, then newest first');
});

test('version: the latest is the default when the current version is not kept', () => {
  const c = firmwareChoices(offer, { version: '21.0.0', patch: 'x' });
  assert.equal(c.selected, '24.4.0');
  assert.ok(!c.options.some((o) => o.kind === 'current'));
});

test('version: a latest offer that is not downloaded yet is listed but not available', () => {
  const c = firmwareChoices({ ...offer, version: '25.0.0', patch_level: 'p25' }, { version: '23.2.6', patch: 'p236' });
  assert.equal(c.selected, '23.2.6');
  assert.equal(c.options.find((o) => o.version === '25.0.0').available, false);
});

// ------------------------------------------------------------------ firmware-cache.js
const { FirmwareCache, HOUR } = require(path.join(repo, 'firmware-cache.js'));

// a pretend NumWorks: what it offers per model, whether it's reachable, and every call counted
function fakeNumWorks() {
  const nw = { up: true, offers: { N0120: '24.4.0', N0110: '23.2.6', N0115: '23.2.6' }, calls: [] };
  nw.fetchInfo = async (model) => {
    nw.calls.push(['info', model]);
    if (!nw.up) throw Object.assign(new Error('Could not reach my.numworks.com: ENOTFOUND'), { status: 502, i18n: { code: 'nw.unreachable', params: { msg: 'ENOTFOUND' } } });
    return { name: 'stable', info: { version: nw.offers[model], patch_level: 'p' + nw.offers[model] } };
  };
  nw.fetchFirmware = async (model, name) => {
    nw.calls.push(['dfu', model, name]);
    if (!nw.up) throw new Error('offline');
    return Buffer.from(`firmware ${model} ${nw.offers[model]}`);
  };
  return nw;
}
// timers the test drives itself
function fakeTimers() {
  const t = { intervals: [] };
  t.setInterval = (fn, ms) => { const h = { fn, ms }; t.intervals.push(h); return h; };
  t.clearInterval = (h) => { t.intervals = t.intervals.filter((x) => x !== h); };
  t.tick = () => Promise.all(t.intervals.map((h) => h.fn()));
  return t;
}
const settle = () => new Promise((ok) => setTimeout(ok, 20));
let cacheN = 0;
function newCache(nw, timers = fakeTimers(), dir = path.join(tmp, 'fw' + cacheN++)) {
  return { cache: new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers }), timers, dir };
}

test('cache: checks once at start, then on an hourly timer', async () => {
  const nw = fakeNumWorks();
  const { cache, timers } = newCache(nw);
  cache.start();
  await settle();
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, HOUR);
  assert.equal(HOUR, 3600000);
  assert.deepEqual(nw.calls.filter((c) => c[0] === 'info'), [['info', 'N0120']], 'the startup check, for the one known model');
  nw.offers.N0120 = '24.5.0';
  await timers.tick();  // an hour later
  assert.equal(nw.calls.filter((c) => c[0] === 'info').length, 2);
  assert.deepEqual(cache.info('N0120').versions.map((v) => v.version), ['24.5.0', '24.4.0'], 'the old version is kept');
  cache.stop();
  assert.equal(timers.intervals.length, 0);
});

test('cache: page requests never reach NumWorks for a known model', async () => {
  const nw = fakeNumWorks();
  const { cache } = newCache(nw);
  await cache.refreshAll();
  const before = nw.calls.length;
  for (let n = 0; n < 5; n++) { cache.info('N0120'); cache.firmware('N0120', '24.4.0'); cache.firmware('N0120'); }
  await settle();
  assert.equal(nw.calls.length, before);
});

test('cache: NumWorks unreachable falls back on the kept copies, with a notice', async () => {
  const nw = fakeNumWorks();
  const { cache } = newCache(nw);
  await cache.refreshAll();
  nw.up = false;
  await cache.refreshAll();
  const info = cache.info('N0120');
  assert.equal(info.version, '24.4.0');
  assert.equal(info.cache.offline, true);
  assert.equal(info.cache.error.code, 'nw.unreachable');
  assert.deepEqual(cache.firmware('N0120', '24.4.0').body, Buffer.from('firmware N0120 24.4.0'));
});

test('cache: never reached NumWorks and nothing kept: a clear error, not a crash', async () => {
  const nw = fakeNumWorks();
  nw.up = false;
  const { cache } = newCache(nw);
  await cache.refreshAll();
  assert.throws(() => cache.info('N0120'), (e) => e.status === 502 && e.i18n.code === 'nw.unreachable');
});

test('cache: a model is cached from the first time it is recognized', async () => {
  const nw = fakeNumWorks();
  const { cache, timers, dir } = newCache(nw);
  assert.deepEqual(cache.index.knownModels, ['N0120'], 'only the N0120 has been seen');
  await cache.refreshAll();
  assert.ok(!nw.calls.some((c) => c[1] === 'N0110' || c[1] === 'N0115'), 'unseen models are not fetched');
  assert.throws(() => cache.info('N0110'), (e) => e.status === 503 && e.i18n.code === 'fw.cachePending', 'first sight: not kept yet');
  await settle();
  assert.deepEqual(cache.index.knownModels, ['N0120', 'N0110']);
  assert.equal(cache.info('N0110').version, '23.2.6', 'its first check ran');
  assert.ok(fs.existsSync(path.join(dir, 'N0110', '23.2.6', 'firmware.dfu')));
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(idx.knownModels, ['N0120', 'N0110'], 'kept in index.json');
  // from then on the hourly timer covers it, and the N0115 still isn't
  cache.start();
  await settle();
  nw.calls.length = 0;
  await timers.tick();
  assert.deepEqual(nw.calls.filter((c) => c[0] === 'info').map((c) => c[1]), ['N0120', 'N0110']);
  cache.stop();
});

test('cache: files are kept per model and version with their sha256, and never overwritten', async () => {
  const nw = fakeNumWorks();
  const { cache, dir } = newCache(nw);
  await cache.refreshAll();
  const file = path.join(dir, 'N0120', '24.4.0', 'firmware.dfu');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'N0120', '24.4.0', 'metadata.json'), 'utf8'));
  assert.equal(meta.sha256, sha256(fs.readFileSync(file)));
  assert.equal(meta.version, '24.4.0');
  // the same version again: not downloaded again
  await cache.refreshAll();
  assert.equal(nw.calls.filter((c) => c[0] === 'dfu').length, 1);
  // a kept file whose bytes no longer match is not served; a new download with other bytes doesn't replace a file
  fs.writeFileSync(file, 'tampered');
  assert.throws(() => cache.firmware('N0120', '24.4.0'), (e) => e.i18n.code === 'fw.notCached');
  await cache.refreshAll();
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered', 'never overwritten');
  assert.equal(cache.info('N0120').cache.error.code, 'fw.cacheConflict');
});

test('cache: the index survives a restart', async () => {
  const nw = fakeNumWorks();
  const { cache, dir } = newCache(nw);
  await cache.refreshAll();
  const again = new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers: fakeTimers() });
  assert.equal(again.info('N0120').version, '24.4.0');
  assert.ok(again.index.lastChecked);
});

// ------------------------------------------------------------------ numplay.js: pinned and checked
test('numplay: only the manifest\'s files, only with their pinned sha256', async () => {
  const good = Buffer.from('window.npApps = {};'), evil = Buffer.from('alert(1)');
  const manifestFile = path.join(tmp, 'manifest.json'), npCache = path.join(tmp, 'np');
  fs.writeFileSync(manifestFile, JSON.stringify({ sources: { 'kit/': 'https://raw.githubusercontent.com/o/r/' + 'a'.repeat(40) + '/',
    'apps.js': 'https://raw.githubusercontent.com/o/r/' + 'b'.repeat(40) + '/customize/apps.js' },
    files: { 'apps.js': { sha256: sha256(good) }, 'kit/kit.json': { sha256: sha256(Buffer.from('{}')) } } }));
  process.env.NUMPLAY_MANIFEST = manifestFile;
  process.env.NUMPLAY_CACHE = npCache;
  const numplay = require(path.join(repo, 'numplay.js'));
  let serve = good;
  const fetched = [];
  numplay.setFetcher(async (url) => { fetched.push(url); return { status: 200, body: serve }; });
  const call = async (p) => {
    const res = { status: 0, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
    await numplay({}, res, new URL('http://localhost' + p));
    return res;
  };
  let r = await call('/numplay/apps.js');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, good);
  assert.match(fetched[0], /^https:\/\/raw\.githubusercontent\.com\/o\/r\/b{40}\/customize\/apps\.js$/, 'fetched at the pinned commit');
  r = await call('/numplay/apps.js');
  assert.equal(fetched.length, 1, 'then from the verified copy');

  fs.writeFileSync(path.join(npCache, 'apps.js'), evil);  // a kept copy that was changed
  serve = evil;  // and upstream changed too
  r = await call('/numplay/apps.js');
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.body).code, 'numplay.hash');

  fetched.length = 0;
  for (const p of ['/numplay/kit/evil.js', '/numplay/kit%2F..%2F..%2Fserver.js', '/numplay/other.js']) assert.equal((await call(p)).status, 404, p);
  assert.equal(fetched.length, 0, 'paths outside the allowlist are never fetched');
});

test('numplay: the real manifest pins full commit SHAs on raw.githubusercontent.com', () => {
  const m = JSON.parse(fs.readFileSync(path.join(repo, 'numplay-manifest.json'), 'utf8'));
  assert.match(m.kitCommit, /^[0-9a-f]{40}$/);
  assert.match(m.mainCommit, /^[0-9a-f]{40}$/);
  for (const u of Object.values(m.sources)) assert.ok(u.startsWith('https://raw.githubusercontent.com/Mason363/NumPlay/'), u);
  for (const [k, v] of Object.entries(m.files)) assert.match(v.sha256, /^[0-9a-f]{64}$/, k);
  for (const k of ['apps.js', 'pico.js', 'kit/kit.json', 'kit/base.o.gz', 'kit/arena.o.gz']) assert.ok(m.files[k], k);
});

// ------------------------------------------------------------------ server.js
test('server: security headers on every response; /api/firmware reads only the cache', async () => {
  // a pretend NumWorks that counts what it's asked (it should be asked nothing)
  let hits = 0;
  const fake = http.createServer((req, res) => { hits++; res.writeHead(500); res.end(); });
  await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
  // a cache already holding the N0120's 24.4.0
  const dir = path.join(tmp, 'srv-cache');
  const nw = fakeNumWorks();
  await new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers: fakeTimers() }).refreshAll();
  const port = 19642 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [path.join(repo, 'server.js'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NUMWORKS_URL: 'http://127.0.0.1:' + fake.address().port, NUMWORKS_ACCOUNT: path.join(tmp, 'none.json'),
      NWA_FW_CACHE: dir, NWA_FW_SCHEDULE: '0' } });
  try {
    await new Promise((ok) => server.stdout.once('data', ok));
    for (const p of ['/', '/app.js', '/nope', '/api/status', '/api/firmware/N0120.json', '/api/firmware/N0120.dfu?version=24.4.0', '/api/nope']) {
      const r = await fetch(`http://localhost:${port}${p}`);
      const csp = r.headers.get('content-security-policy') || '';
      for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), `${p}: CSP has ${d}`);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
      if (p === '/api/firmware/N0120.json') {
        const j = await r.json();
        assert.equal(j.version, '24.4.0');
        assert.deepEqual(j.versions.map((v) => v.version), ['24.4.0']);
      } else if (p.includes('.dfu')) assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'firmware N0120 24.4.0');
      else await r.arrayBuffer();
    }
    assert.equal(hits, 0, 'no request reached NumWorks');
    // the page has no inline script or style the CSP would block
    const html = fs.readFileSync(path.join(repo, 'public', 'index.html'), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
    assert.ok(!/<style\b/i.test(html) && !/\sstyle="/i.test(html) && !/\son[a-z]+="/i.test(html), 'no inline style or handlers');
  } finally {
    server.kill();
    fake.close();
  }
});

// ------------------------------------------------------------------ run
let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`fixes: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
