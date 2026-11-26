// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the review fixes and the firmware cache, with no network at all (pretend NumWorks and NumPlay):
//  - storage: UTF-8 names survive a round trip (café.py stays café.py); records over 64 KB and overfull storage refused
//  - the firmware version offered by default: the calculator's own when it's kept, else the latest
//  - firmware-cache.js: all known models seeded; stable and beta kept per model, channel and version; checks once at
//    start and then every hour; requests only read the cache; a missing channel or model is skipped; falls back to the
//    kept copies when NumWorks can't be reached; a model not on the list is added when first seen; never overwrites
//  - model.js: the model only from the USB descriptor; the N0100, old or unofficial software, unknown models refused
//  - official.js: official Epsilon allowed; third-party DFU string, Upsilon/Omega markers, Upsilon bootloader refused
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
const { FirmwareCache, HOUR, SEED_MODELS } = require(path.join(repo, 'firmware-cache.js'));

// a pretend NumWorks: what it offers per model and channel (a missing entry is HTTP 404), whether it's reachable, and
// every call counted
function fakeNumWorks() {
  const nw = { up: true, calls: [],
    offers: { N0120: { stable: '24.4.0', beta: '25.0.0' }, N0110: { stable: '23.2.6' }, N0115: { stable: '23.2.6' }, N0100: { stable: '15.3.1' } } };
  const notFound = () => Object.assign(new Error('my.numworks.com: HTTP 404'), { status: 404, i18n: { code: 'nw.firmwareHttp', params: { status: 404 } } });
  nw.fetchInfo = async (model, channel) => {
    nw.calls.push(['info', model, channel]);
    if (!nw.up) throw Object.assign(new Error('Could not reach my.numworks.com: ENOTFOUND'), { status: 502, i18n: { code: 'nw.unreachable', params: { msg: 'ENOTFOUND' } } });
    const v = nw.offers[model]?.[channel];
    if (!v) throw notFound();
    return { name: channel, info: { version: v, patch_level: 'p' + v } };
  };
  nw.fetchFirmware = async (model, name) => {
    nw.calls.push(['dfu', model, name]);
    if (!nw.up) throw new Error('offline');
    return Buffer.from(`firmware ${model} ${name} ${nw.offers[model][name]}`);
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
const infoCalls = (nw) => nw.calls.filter((c) => c[0] === 'info');
let cacheN = 0;
function newCache(nw, timers = fakeTimers(), dir = path.join(tmp, 'fw' + cacheN++)) {
  return { cache: new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers }), timers, dir };
}

test('cache: every known model is seeded from the start', () => {
  const { cache } = newCache(fakeNumWorks());
  assert.deepEqual(cache.index.knownModels, ['N0110', 'N0115', 'N0120', 'N0120_PORTUGAL_PROTOTYPE_20210930']);
  assert.deepEqual(SEED_MODELS, cache.index.knownModels);
});

test('cache: checks every seeded model and both channels at start, then on an hourly timer', async () => {
  const nw = fakeNumWorks();
  const { cache, timers } = newCache(nw);
  cache.start();
  await settle();
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, HOUR);
  assert.equal(HOUR, 3600000);
  assert.deepEqual(infoCalls(nw).map((c) => c[1] + ' ' + c[2]), SEED_MODELS.flatMap((m) => [m + ' stable', m + ' beta']));
  nw.offers.N0120.stable = '24.5.0';
  await timers.tick();  // an hour later
  assert.equal(infoCalls(nw).length, 2 * 2 * SEED_MODELS.length);
  assert.deepEqual(cache.info('N0120').versions.map((v) => v.version + ' ' + v.channel), ['25.0.0 beta', '24.5.0 stable', '24.4.0 stable'], 'old versions kept');
  cache.stop();
  assert.equal(timers.intervals.length, 0);
});

test('cache: stable and beta are both kept, per model, channel and version', async () => {
  const nw = fakeNumWorks();
  const { cache, dir } = newCache(nw);
  await cache.refreshAll();
  for (const [ch, v] of [['stable', '24.4.0'], ['beta', '25.0.0']]) {
    const file = path.join(dir, 'N0120', ch, v, 'firmware.dfu');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'N0120', ch, v, 'metadata.json'), 'utf8'));
    assert.equal(meta.sha256, sha256(fs.readFileSync(file)), ch);
    assert.equal(meta.channel, ch);
  }
  const info = cache.info('N0120');
  assert.equal(info.version, '24.4.0', 'the stable offer is the main one');
  assert.deepEqual(info.channels, { stable: { version: '24.4.0', patch_level: 'p24.4.0', cached: true }, beta: { version: '25.0.0', patch_level: 'p25.0.0', cached: true } });
  assert.equal(cache.firmware('N0120', '25.0.0', 'beta').body.toString(), 'firmware N0120 beta 25.0.0');
  assert.equal(cache.firmware('N0120', '25.0.0').channel, 'beta', 'found in beta without naming it');
});

test('cache: a missing channel or model is skipped, not an error', async () => {
  const nw = fakeNumWorks();
  const logs = [];
  const { cache } = newCache(nw);
  cache.log = (m) => logs.push(m);
  await cache.refreshAll();
  const n110 = cache.info('N0110');
  assert.equal(n110.version, '23.2.6');
  assert.equal(n110.cache.offline, false, 'no beta for the N0110: no error');
  assert.equal(cache.index.models.N0110.channels.beta.missing, true);
  assert.throws(() => cache.info('N0120_PORTUGAL_PROTOTYPE_20210930'), (e) => e.status === 404 && e.i18n.code === 'fw.noneForModel');
  assert.equal(cache.index.models.N0120_PORTUGAL_PROTOTYPE_20210930.channels.stable.lastError, null);
  assert.ok(logs.some((l) => /no beta firmware for the N0110, skipped/.test(l)));
});

test('cache: page requests never reach NumWorks for a known model', async () => {
  const nw = fakeNumWorks();
  const { cache } = newCache(nw);
  await cache.refreshAll();
  const before = nw.calls.length;
  for (let n = 0; n < 5; n++) { cache.info('N0120'); cache.info('n0110'); cache.firmware('N0120', '24.4.0'); cache.firmware('N0120'); }
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
  assert.equal(cache.firmware('N0120', '24.4.0').body.toString(), 'firmware N0120 stable 24.4.0');
});

test('cache: never reached NumWorks and nothing kept: a clear error, not a crash', async () => {
  const nw = fakeNumWorks();
  nw.up = false;
  const { cache } = newCache(nw);
  await cache.refreshAll();
  assert.throws(() => cache.info('N0120'), (e) => e.status === 502 && e.i18n.code === 'nw.unreachable');
});

test('cache: a model not on the list is added and cached when first detected', async () => {
  const nw = fakeNumWorks();
  nw.offers.N0130 = { stable: '30.0.0' };
  const { cache, timers, dir } = newCache(nw);
  await cache.refreshAll();
  assert.ok(!nw.calls.some((c) => c[1] === 'N0130'), 'not fetched before it is seen');
  assert.throws(() => cache.info('n0130'), (e) => e.status === 503 && e.i18n.code === 'fw.cachePending', 'first sight: not kept yet');
  await settle();
  assert.ok(cache.index.knownModels.includes('N0130'), 'added, with its name normalized');
  assert.equal(cache.info('N0130').version, '30.0.0', 'its first check ran');
  assert.ok(fs.existsSync(path.join(dir, 'N0130', 'stable', '30.0.0', 'firmware.dfu')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).knownModels.includes('N0130'), 'kept in index.json');
  cache.start();
  await settle();
  nw.calls.length = 0;
  await timers.tick();
  assert.ok(infoCalls(nw).some((c) => c[1] === 'N0130'), 'then on the hourly timer');
  cache.stop();
  assert.throws(() => cache.info('../etc'), (e) => e.status === 400, 'not a model name');
});

test('cache: files are never overwritten, and a changed one is not served', async () => {
  const nw = fakeNumWorks();
  const { cache, dir } = newCache(nw);
  await cache.refreshAll();
  await cache.refreshAll();
  assert.equal(nw.calls.filter((c) => c[0] === 'dfu' && c[1] === 'N0120').length, 2, 'stable and beta once each, not again');
  const file = path.join(dir, 'N0120', 'stable', '24.4.0', 'firmware.dfu');
  fs.writeFileSync(file, 'tampered');
  assert.throws(() => cache.firmware('N0120', '24.4.0', 'stable'), (e) => e.i18n.code === 'fw.notCached');
  await cache.refreshAll();
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered', 'never overwritten');
  assert.equal(cache.info('N0120').cache.error.code, 'fw.cacheConflict');
});

test('cache: the N0100 is never cached: not seeded, dropped from an old index, refused when asked', async () => {
  const dir = path.join(tmp, 'n0100-index');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ knownModels: ['N0100', 'N0120'], models: { N0100: { channels: {} } } }));
  const nw = fakeNumWorks();
  const c = new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers: fakeTimers() });
  assert.ok(!c.index.knownModels.includes('N0100') && !c.index.models.N0100, 'dropped on load');
  await c.refreshAll();
  assert.ok(!nw.calls.some((x) => x[1] === 'N0100'), 'never fetched');
  assert.throws(() => c.info('N0100'), (e) => e.status === 400 && e.i18n.code === 'calc.n0100');
  assert.throws(() => c.firmware('n0100'), (e) => e.i18n.code === 'calc.n0100');
  assert.ok(!c.index.knownModels.includes('N0100'), 'not added by a request either');
});

test('cache: an older index (only the N0120) gets every seeded model on load', async () => {
  const dir = path.join(tmp, 'old-index');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ knownModels: ['N0120'], models: {} }));
  const nw = fakeNumWorks();
  const c = new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers: fakeTimers() });
  assert.deepEqual(c.index.knownModels, SEED_MODELS);
  await c.refreshAll();
  const again = new FirmwareCache({ dir, fetchInfo: nw.fetchInfo, fetchFirmware: nw.fetchFirmware, timers: fakeTimers() });
  assert.equal(again.info('N0120').version, '24.4.0', 'and survives a restart');
});

test('version: a kept beta is labeled, and never the default unless the calculator runs it', () => {
  const info = { version: '24.4.0', patch_level: 'p', channel: 'stable', versions: [
    { version: '25.0.0', channel: 'beta', patch_level: 'b' }, { version: '24.4.0', channel: 'stable', patch_level: 'p' }] };
  let c = firmwareChoices(info, { version: '20.0.0' });
  assert.equal(c.selected, '24.4.0');
  assert.equal(c.options.find((o) => o.version === '25.0.0').channel, 'beta');
  c = firmwareChoices(info, { version: '25.0.0' });
  assert.equal(c.selected, '25.0.0', 'on the beta already: stay on it');
});

// ------------------------------------------------------------------ which model (model.js)
const { detectModel, usbVersionOf } = await import('../public/lib/model.js');
// the memories each model's DFU interface shows (Epsilon's usb_userland.h / Upsilon.js)
const MEM = {
  N0100: [{ name: 'Internal Flash', segments: [{ start: 0x08000000, end: 0x08100000 }] }, { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000 }] }],
  N0110: [{ name: 'Flash', segments: [{ start: 0x90030000, end: 0x90400000 }] }, { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000 }] }],
  N0115: [{ name: 'Flash', segments: [{ start: 0x90030000, end: 0x90400000 }] }, { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000 }] }],
  N0120: [{ name: 'Flash', segments: [{ start: 0x90030000, end: 0x90400000 }] }, { name: 'SRAM', segments: [{ start: 0x24000000, end: 0x2403f000 }] }],
};
// a WebUSB device as the calculator describes itself: bcdDevice 0x0115 is 1.1.5
const usbDev = (bcd, productName = 'NumWorks Calculator', serialNumber = 'SER' + bcd) => ({ productName, serialNumber,
  deviceVersionMajor: bcd >> 8, deviceVersionMinor: (bcd >> 4) & 15, deviceVersionSubminor: bcd & 15 });
const detect = (dev, layouts) => detectModel({ usbVersion: usbVersionOf(dev), productName: dev.productName, serialNumber: dev.serialNumber, layouts });

test('model: N0110, N0115, N0120, the Portugal prototype and the N0200 from the USB descriptor', () => {
  for (const [model, bcd] of [['N0110', 0x0110], ['N0115', 0x0115], ['N0120', 0x0120]]) assert.deepEqual(detect(usbDev(bcd), MEM[model]), { model }, model);
  assert.deepEqual(detect(usbDev(0x0115), MEM.N0110), { model: 'N0115' }, 'the descriptor, not the memories');
  assert.deepEqual(detect(usbDev(0x0120, 'NumWorks Calculator', 'EAAbABVROTUxNDM4'), MEM.N0120), { model: 'N0120_PORTUGAL_PROTOTYPE_20210930' });
  assert.deepEqual(detect(usbDev(0x0200, 'NumWorks Scientific Calculator'), []), { model: 'N0200' });
});

test('model: never a guess: the N0100 refused, an outdated N0110/N0115 asked, the rest refused', () => {
  assert.deepEqual(detect(usbDev(0x0100), MEM.N0100), { refuse: 'calc.n0100' });
  for (const m of ['N0110', 'N0115']) assert.deepEqual(detect(usbDev(0x0100), MEM[m]), { limited: 'outdated' }, m + ' on old software: which one is asked');
  assert.deepEqual(detect(usbDev(0x0100), MEM.N0120), { refuse: 'calc.updateFirst' }, 'the N0120 (its RAM) keeps the old rule');
  assert.deepEqual(detect(usbDev(0x0110, 'Upsilon Calculator'), MEM.N0110), { refuse: 'calc.updateFirst' }, 'a fork\'s number is not trusted');
  assert.deepEqual(detectModel({ usbVersion: null, layouts: MEM.N0110 }), { refuse: 'calc.updateFirst' }, 'no descriptor');
  assert.deepEqual(detect(usbDev(0x0130), MEM.N0120), { refuse: 'calc.unknownModel', bcd: '1.3.0' });
});

test('model: an unlisted version (Android reports an N0120 as 1.1.4) falls back to the memories, clear match only', () => {
  assert.deepEqual(detect(usbDev(0x0114), MEM.N0120), { model: 'N0120' }, '1.1.4 + N0120 memories');
  assert.deepEqual(detect(usbDev(0x0114, 'NumWorks Calculator', 'EAAbABVROTUxNDM4'), MEM.N0120), { model: 'N0120_PORTUGAL_PROTOTYPE_20210930' });
  assert.deepEqual(detect(usbDev(0x0114), MEM.N0110), { refuse: 'calc.unknownModel', bcd: '1.1.4' }, 'N0110/N0115 memories: ambiguous, unknown');
  assert.deepEqual(detect(usbDev(0x0114), []), { refuse: 'calc.unknownModel', bcd: '1.1.4' }, 'no layout');
  assert.deepEqual(detect(usbDev(0x0114), [{ name: 'SRAM', segments: [{ start: 0x24000000, end: 0x2403f000 }] }]), { refuse: 'calc.unknownModel', bcd: '1.1.4' }, 'RAM only: not clear');
  assert.deepEqual(detect(usbDev(0x0114, 'Upsilon Calculator'), MEM.N0120), { refuse: 'calc.updateFirst' }, 'a fork\'s name is not trusted');
  assert.deepEqual(detect(usbDev(0x0130), MEM.N0120), { refuse: 'calc.unknownModel', bcd: '1.3.0' }, '1.3.0 stays unknown even with N0120 memories');
});

test('model: manual pick (unknown version, and always on Android), checked against the memories', async () => {
  const { isAndroid, versionMatches, pickableModels } = await import('../public/lib/model.js');
  const d = (bcd, layouts, chosen, manual, name, serial) => detectModel({ usbVersion: usbVersionOf(usbDev(bcd, name, serial)), productName: name || 'NumWorks Calculator', serialNumber: serial || '', layouts, chosen, manual });
  // valid picks matching the memories
  assert.deepEqual(d(0x0130, MEM.N0120, 'N0120'), { model: 'N0120', picked: true });
  for (const m of ['N0110', 'N0115']) assert.deepEqual(d(0x0130, MEM.N0110, m), { model: m, picked: true }, m);
  // contradicting the memories: refused
  assert.deepEqual(d(0x0130, MEM.N0120, 'N0110'), { refuse: 'calc.pickMismatch', bcd: '1.3.0', model: 'N0110' });
  assert.deepEqual(d(0x0130, MEM.N0110, 'N0120'), { refuse: 'calc.pickMismatch', bcd: '1.3.0', model: 'N0120' });
  assert.deepEqual(d(0x0130, [], 'N0120'), { refuse: 'calc.pickMismatch', bcd: '1.3.0', model: 'N0120' }, 'no layout');
  // unsupported picks refused
  for (const m of ['N0100', 'N0200', 'N9999', '']) assert.equal(d(0x0130, MEM.N0120, m).refuse, 'calc.unknownModel', 'pick ' + m);
  // not asked at all: an untrusted name, or a version the page knows (without manual)
  assert.deepEqual(pickableModels({ productName: 'Upsilon Calculator', layouts: MEM.N0120 }), []);
  assert.deepEqual(pickableModels({ productName: 'NumWorks Calculator', layouts: MEM.N0120 }), ['N0120']);
  assert.deepEqual(pickableModels({ productName: 'NumWorks Calculator', layouts: MEM.N0110 }), ['N0110', 'N0115']);
  assert.deepEqual(pickableModels({ productName: 'NumWorks Calculator', layouts: MEM.N0100 }), []);
  assert.deepEqual(d(0x0110, MEM.N0110, 'N0120'), { model: 'N0110' }, 'a known version ignores a pick');
  assert.equal(d(0x0130, MEM.N0120, 'N0120', false, 'Upsilon Calculator').refuse, 'calc.updateFirst', 'untrusted name refused');
  // manual (Android): the USB version is never trusted, even a listed one
  assert.deepEqual(d(0x0120, MEM.N0120, null, true), { refuse: 'calc.unknownModel', bcd: '1.2.0' });
  assert.deepEqual(d(0x0114, MEM.N0120, null, true), { refuse: 'calc.unknownModel', bcd: '1.1.4' }, 'no silent N0120 either');
  assert.deepEqual(d(0x0114, MEM.N0120, 'N0120', true), { model: 'N0120', picked: true });
  assert.equal(d(0x0120, MEM.N0120, 'N0110', true).refuse, 'calc.pickMismatch', 'the memories still win on Android');
  assert.deepEqual(d(0x0100, MEM.N0110, null, true), { limited: 'outdated' }, '1.0.0 keeps its own flow');
  // Android and version helpers
  assert.ok(isAndroid({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/130' }));
  assert.ok(isAndroid({ userAgentData: { platform: 'Android' }, userAgent: '' }));
  assert.ok(!isAndroid({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' }));
  assert.ok(versionMatches('24.4.0', '24.4.0') && versionMatches('v24.4', '24.4.0') && versionMatches('24', '24.4.0'));
  assert.ok(!versionMatches('24.5.0', '24.4.0') && !versionMatches('', '24.4.0') && !versionMatches('abc', '24.4.0') && !versionMatches('24.4.0.1', '24.4.0'));
});

test('model: readInfo with a pick: pickMismatch, and the version entered must be the calculator\'s', async () => {
  const { readInfo } = await import('../public/lib/calc.js');
  const dfu = (dev, layouts) => ({ device: dev, layouts, read: async (a, n) => new Uint8Array(n).fill(0xff) });
  await assert.rejects(readInfo(dfu(usbDev(0x0114), MEM.N0120), {}), (e) => e.code === 'calc.tooOld', '1.1.4 + N0120 memories: detected, then reading goes on (no slot info here)');
  await assert.rejects(readInfo(dfu(usbDev(0x0114), MEM.N0120), { chosenModel: 'N0110', manual: true }), (e) => e.code === 'calc.pickMismatch');
  await assert.rejects(readInfo(dfu(usbDev(0x0130), MEM.N0120), {}), (e) => e.code === 'calc.unknownModel' && e.pick.join() === 'N0120');
  await assert.rejects(readInfo(dfu(usbDev(0x0130), MEM.N0110), {}), (e) => e.code === 'calc.unknownModel' && e.pick.join() === 'N0110,N0115');
  await assert.rejects(readInfo(dfu(usbDev(0x0130, 'Upsilon Calculator'), MEM.N0110), {}), (e) => e.code === 'calc.updateFirst');
});

test('model: readInfo refuses what it can\'t work with, with its own code; outdated firmware: limited', async () => {
  const { readInfo } = await import('../public/lib/calc.js');
  const dfu = (dev, layouts) => ({ device: dev, layouts, read: async (a, n) => new Uint8Array(n).fill(0xff) });
  await assert.rejects(readInfo(dfu(usbDev(0x0100), MEM.N0100)), (e) => e.code === 'calc.n0100');
  assert.deepEqual(await readInfo(dfu(usbDev(0x0100), MEM.N0110)), { model: null, limited: 'outdated', serial: 'SER256' });
  await assert.rejects(readInfo(dfu(usbDev(0x0100), MEM.N0120)), (e) => e.code === 'calc.updateFirst' && /my\.numworks\.com\/devices\/upgrade/.test(e.message));
  await assert.rejects(readInfo(dfu(usbDev(0x0110), MEM.N0110)), (e) => e.code === 'calc.tooOld', 'no slot info: not supported');
});

test('model: the page has no model picker left, and hidden always hides', () => {
  const html = fs.readFileSync(path.join(repo, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(repo, 'public', 'app.js'), 'utf8');
  assert.ok(!/model-ask|model-pick|model-change/.test(html + app), 'no picker in the page');
  const css = fs.readFileSync(path.join(repo, 'public', 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, '[hidden] wins over a class\'s display');
});

// ------------------------------------------------------------------ official software only (official.js)
const { checkOfficial, THIRD_PARTY, AUTHENTICATED } = await import('../public/lib/official.js');
const SRAM = '@SRAM/0x24000000/01*252Ke';
// what official Epsilon has right after its userland header: ISR words and trampoline pointers
const epsilonAfter = Uint8Array.from([0x00, 0x00, 0x04, 0x24, 0x39, 0x01, 0x03, 0x90, ...new Array(88).fill(0).map((_, i) => (i % 4 === 3 ? 0x90 : i))]);
const withMarker = (m) => { const b = new Uint8Array(96).fill(0x11); b.set(m, 40); return b; };

test('official: Epsilon, signed (with .nwa apps or not), in slot A or B, is allowed', () => {
  for (const flash of AUTHENTICATED) {
    const r = checkOfficial({ productName: 'NumWorks Calculator', flashStrings: [flash, SRAM], afterUserland: epsilonAfter });
    assert.deepEqual(r, { official: true, reason: null, known: true }, flash);
  }
});

test('official: the third-party DFU string of the running slot is refused', () => {
  for (const flash of THIRD_PARTY) {
    assert.equal(checkOfficial({ productName: 'NumWorks Calculator', flashStrings: [flash, SRAM], afterUserland: epsilonAfter }).reason, 'thirdParty', flash);
  }
});

test('official: Upsilon and Omega markers, and Upsilon\'s bootloader, are refused', () => {
  const base = { productName: 'NumWorks Calculator', flashStrings: [AUTHENTICATED[0], SRAM] };
  assert.equal(checkOfficial({ ...base, afterUserland: withMarker([0x69, 0x73, 0x70, 0x55]) }).reason, 'upsilon');
  assert.equal(checkOfficial({ ...base, afterUserland: withMarker([0xde, 0xad, 0xbe, 0xef]) }).reason, 'omega');
  assert.equal(checkOfficial({ productName: 'Upsilon Bootloader' }).reason, 'upsilonBootloader');
});

test('official: an undocumented DFU string is allowed (fail-open), and slot B is never read', async () => {
  const r = checkOfficial({ productName: 'NumWorks Calculator', flashStrings: ['@Flash/0x90000000/128*064Kg'], afterUserland: epsilonAfter });
  assert.deepEqual(r, { official: true, reason: null, known: false });
  // readInfo on a calculator running slot A whose slot B is full of apps (Nwagra), markers and all: never read
  const { readInfo, SLOT_B } = await import('../public/lib/calc.js');
  const le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const str = (s, n) => [...Buffer.from(s.padEnd(n, '\0'))];
  const SLOT = [0xba, 0xdb, 0xee, 0xef], KERNEL = [0xf0, 0x0d, 0xc0, 0xde], USERLAND = [0xfe, 0xed, 0xc0, 0xde];
  const mem = new Map([[0x24000000, [...SLOT, ...le(0x90000008), ...le(0x90010000), ...SLOT]],
    [0x90000008, [...KERNEL, ...str('26.4.0', 8), ...str('cc9262e', 8), ...KERNEL]],
    [0x90010000, [...USERLAND, ...str('26.4.0', 8), ...le(0x24030000), ...le(0x8000), ...le(0x90180000), ...le(0x903f0000),
      ...le(0x24010000), ...le(0x24020000), ...USERLAND, ...epsilonAfter]]]);
  const reads = [];
  const dfu = { device: usbDev(0x0120), layouts: [{ name: 'Flash', raw: AUTHENTICATED[0], segments: [{ start: 0x90030000, end: 0x907f0000 }] },
    { name: 'SRAM', raw: SRAM, segments: [{ start: 0x24000000, end: 0x2403f000 }] }],
    read: async (addr, n) => {
      reads.push(addr);
      if (addr >= SLOT_B) return withMarker([0x69, 0x73, 0x70, 0x55]).subarray(0, n);  // slot B: apps (here even a marker)
      for (const [a, b] of mem) if (addr >= a && addr < a + b.length) return Uint8Array.from({ length: n }, (_, i) => b[addr - a + i] ?? 0);
      return new Uint8Array(n).fill(0xff);
    } };
  const info = await readInfo(dfu);
  assert.equal(info.firmwareCheck.official, true);
  assert.equal(info.slot, 'A');
  assert.ok(!reads.some((a) => a >= SLOT_B && a !== SLOT_B + 8), 'slot B: at most its kernel header, for Nwagra\'s note');
  // the same calculator with a third-party DFU string: refused with its own code
  dfu.layouts[0].raw = THIRD_PARTY[0];
  await assert.rejects(readInfo(dfu), (e) => e.code === 'calc.unofficial.thirdParty');
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
        assert.deepEqual(j.versions.map((v) => v.version + ' ' + v.channel), ['25.0.0 beta', '24.4.0 stable']);
      } else if (p.includes('.dfu')) assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'firmware N0120 stable 24.4.0');
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
