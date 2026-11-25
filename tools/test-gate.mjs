// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the half-supported calculators (public/lib/gate.js), the TEST MODE (public/lib/simulate.js) and the one gate
// for every developer feature (public/lib/env.js, fed by server.js from NODE_ENV). No network, no calculator:
//  - the N0100: refused (refusal screen, no OK), nothing read from it, never any firmware (assertFirmwareAllowed)
//  - an N0110/N0115 on outdated firmware: model asked, every cached version listed oldest first with the oldest picked,
//    nothing flashed before an explicit confirm of the version shown, then exactly that one; skipping never flashes,
//    shows the warning once per connection, and after its OK the normal page, where what can't work says so
//  - Epsilon 16+, the N0120, the Portugal prototype and the N0200: as before
//  - EN and FR: every new string in both
//  - NODE_ENV=production: ?mock, ?debug and ?debug&simulate=... ignored, the mock and simulation files not served;
//    any other NODE_ENV: they work
//   node tools/test-gate.mjs
import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (...p) => path.join(repo, 'public', ...p);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { OutdatedFlow, OUTDATED_MODELS, assertFirmwareAllowed, cachedVersions, pickFlasher, limitedView, limitedActionError, limitedFirmwareError } = await import('../public/lib/gate.js');
const { detectModel, usbVersionOf } = await import('../public/lib/model.js');
const { readInfo } = await import('../public/lib/calc.js');
const { simulatedDevice, simulatedFlash, simulatedModel, SIMULATED_IDS, SIMULATED_VERSIONS } = await import('../public/lib/simulate.js');
const { isDevEnv, parseDevFlags, SIMULATIONS } = await import('../public/lib/env.js');

const usbDev = (bcd, productName = 'NumWorks Calculator', serialNumber = 'SER' + bcd) => ({ productName, serialNumber,
  deviceVersionMajor: bcd >> 8, deviceVersionMinor: (bcd >> 4) & 15, deviceVersionSubminor: bcd & 15 });
const MEM = {
  N0100: [{ name: 'Internal Flash', segments: [{ start: 0x08000000, end: 0x08100000 }] }, { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000 }] }],
  N0110: [{ name: 'Flash', segments: [{ start: 0x90030000, end: 0x90400000 }] }, { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000 }] }],
  N0120: [{ name: 'Flash', segments: [{ start: 0x90030000, end: 0x90400000 }] }, { name: 'SRAM', segments: [{ start: 0x24000000, end: 0x2403f000 }] }],
};
const detect = (dev, layouts) => detectModel({ usbVersion: usbVersionOf(dev), productName: dev.productName, serialNumber: dev.serialNumber, layouts });
// a DFU device that records every read and write
const spyDfu = (dev, layouts) => {
  const d = { device: dev, layouts, reads: [], writes: [] };
  d.read = async (a, n) => { d.reads.push(a); return new Uint8Array(n).fill(0xff); };
  d.write = d.program = async (a) => { d.writes.push(a); };
  return d;
};

// what /api/firmware/<model>.json gives: newest first, a version in both channels listed once
const CACHE = {
  N0110: { version: '26.4.0', versions: [{ version: '26.4.0', channel: 'stable', patch_level: 'a', size: 30 },
    { version: '25.0.0', channel: 'beta', patch_level: 'b', size: 25 }, { version: '23.2.6', channel: 'stable', patch_level: 'c', size: 23 },
    { version: '19.5.1', channel: 'stable', patch_level: 'd', size: 19 }] },
  N0115: { version: '24.4.0', versions: [{ version: '24.4.0', channel: 'stable', patch_level: 'e', size: 24 }, { version: '22.2.0', channel: 'stable', patch_level: 'f', size: 22 }] },
};
// a flow with a pretend server and a flasher that records every call
function newFlow(cache = CACHE) {
  const flashed = [], asked = [];
  const flow = new OutdatedFlow({
    loadInfo: async (m) => { asked.push(m); return cache[m] || { versions: [] }; },
    flash: async (model, option) => { flashed.push([model, option.version, option.channel]); return { simulated: false }; },
  });
  return { flow, flashed, asked };
}

// ------------------------------------------------------------------ the N0100
test('N0100: refused when it connects, with its own reason; nothing read or written', async () => {
  assert.deepEqual(detect(usbDev(0x0100), MEM.N0100), { refuse: 'calc.n0100' });
  const d = spyDfu(usbDev(0x0100), MEM.N0100);
  await assert.rejects(readInfo(d), (e) => e.code === 'calc.n0100' && /no storage for \.nwa apps/.test(e.message) && /stopped updating/.test(e.message));
  assert.equal(d.reads.length + d.writes.length, 0, 'not even read');
});

test('N0100: firmware is never allowed, whatever asks (logic guard, not just the page)', async () => {
  for (const m of ['N0100', 'n0100', ' N0100 ']) assert.throws(() => assertFirmwareAllowed(m), (e) => e.code === 'calc.n0100.noFlash', m);
  for (const m of ['N0110', 'N0115', 'N0120', 'N0120_PORTUGAL_PROTOTYPE_20210930', 'N0200']) assert.doesNotThrow(() => assertFirmwareAllowed(m), m);
  // the outdated flow never takes the N0100, even if asked
  const { flow, flashed, asked } = newFlow({ N0100: { versions: [{ version: '19.5.1' }] } });
  await assert.rejects(flow.chooseModel('N0100'), (e) => e.code === 'gate.badModel');
  assert.equal(flow.step, 'model');
  assert.equal(await flow.confirm('19.5.1'), false);
  assert.deepEqual(flashed, []);
  assert.deepEqual(asked, [], 'its versions never even looked up');
  // and a flow forced onto the N0100 still refuses at the confirm
  Object.assign(flow, { step: 'version', model: 'N0100', options: [{ version: '19.5.1' }], selected: '19.5.1' });
  assert.throws(() => assertFirmwareAllowed(flow.model));
  await assert.rejects(flow.confirm('19.5.1'), (e) => e.code === 'calc.n0100.noFlash');
  assert.deepEqual(flashed, []);
});

test('N0100: the page shows the refusal screen (no OK) and has no firmware path for it', () => {
  const app = fs.readFileSync(pub('app.js'), 'utf8'), html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<main>\s*<div id="big-warning" class="big-warning" role="alert" hidden>/, 'the banner is the first thing in the flow');
  assert.match(app, /if \(e\.code === 'calc\.n0100'\) \{ st\.refused = 'n0100';/, 'a refused N0100 sets the refusal screen');
  assert.match(app, /const which = st\.refused \|\| limitedView\(/, 'shown first');
  assert.match(app, /\$\('#big-warning-ok'\)\.hidden = which !== 'outdated';/, 'no OK on the refusal');
  assert.match(app, /if \(!st\.info\) return;\s*assertFirmwareAllowed\(st\.info\.model\);/, 'Check for updates guarded');
  assert.match(app, /if \(!i \|\| i\.limited \|\| !p\?\.available\) return;\s*try \{ assertFirmwareAllowed\(i\.model\); \}/, 'Update guarded');
  assert.match(app, /async function flashOutdated\(model, option\) \{[^]*?assertFirmwareAllowed\(model\);/, 'the outdated flasher guarded');
  const css = fs.readFileSync(pub('style.css'), 'utf8');
  assert.match(css, /\.big-warning \{[^}]*background: #b00020;/);
  assert.match(css, /\.big-warning h2 \{[^}]*font-size: 26px;/);
});

// ------------------------------------------------------------------ an outdated N0110 / N0115
test('outdated: 0x0100 with external flash from a NumWorks calculator asks which model (N0120 and forks keep their rules)', async () => {
  assert.deepEqual(detect(usbDev(0x0100), MEM.N0110), { limited: 'outdated' });
  assert.deepEqual(detect(usbDev(0x0100), MEM.N0120), { refuse: 'calc.updateFirst' });
  assert.deepEqual(detect(usbDev(0x0100, 'Upsilon Calculator'), MEM.N0110), { refuse: 'calc.updateFirst' });
  const d = spyDfu(usbDev(0x0100), MEM.N0110);
  assert.deepEqual(await readInfo(d), { model: null, limited: 'outdated', serial: 'SER256' });
  assert.equal(d.reads.length + d.writes.length, 0);
});

test('outdated: the model must be chosen first; nothing listed or flashed before', async () => {
  const { flow, flashed, asked } = newFlow();
  assert.equal(flow.step, 'model');
  assert.deepEqual(OUTDATED_MODELS, ['N0110', 'N0115']);
  assert.equal(await flow.confirm('26.4.0'), false);
  assert.equal(flow.select('26.4.0'), false);
  for (const bad of ['N0120', 'N0200', '', null]) await assert.rejects(flow.chooseModel(bad), (e) => e.code === 'gate.badModel');
  assert.deepEqual(flashed, []);
  assert.deepEqual(asked, []);
});

test('outdated: every cached version for the chosen model, oldest first, the oldest preselected', async () => {
  for (const model of ['N0110', 'N0115']) {
    const { flow, asked } = newFlow();
    await flow.chooseModel(model);
    assert.deepEqual(asked, [model], 'that model\'s versions');
    assert.equal(flow.step, 'version');
    const want = CACHE[model].versions.map((v) => v.version).reverse();
    assert.deepEqual(flow.options.map((o) => o.version), want, model + ': all of them, oldest first');
    assert.equal(flow.selected, want[0], model + ': the oldest');
  }
  assert.deepEqual(cachedVersions({ versions: [{ version: '24.10.1' }, { version: '24.4.0' }, { version: '24.4.0', channel: 'beta' }, { version: '9.0.0' }] })
    .map((o) => o.version), ['9.0.0', '24.4.0', '24.10.1'], 'numeric order, each version once');
  assert.equal(new OutdatedFlow({}).step, 'model');
});

test('outdated: no flash before the confirm; the confirm flashes exactly the version shown', async () => {
  const { flow, flashed } = newFlow();
  await flow.chooseModel('N0110');
  assert.equal(flow.select('42.0.0'), false, 'not a cached version');
  assert.equal(flow.select('23.2.6'), true);
  assert.deepEqual(flashed, [], 'picking is not flashing');
  assert.equal(await flow.confirm('19.5.1'), false, 'a version other than the one shown');
  assert.equal(await flow.confirm(), false);
  assert.deepEqual(flashed, []);
  assert.equal(await flow.confirm('23.2.6'), true);
  assert.deepEqual(flashed, [['N0110', '23.2.6', 'stable']]);
  assert.equal(flow.step, 'done');
  assert.equal(await flow.confirm('23.2.6'), false, 'once');
  assert.equal(flow.skip(), false, 'too late to skip');
  assert.equal(flashed.length, 1);
});

test('outdated: the default (oldest) is what a straight confirm flashes; N0115 gets N0115 firmware', async () => {
  const { flow, flashed } = newFlow();
  await flow.chooseModel('N0110');
  await flow.chooseModel('N0115');  // changed their mind after reading the back
  await flow.confirm(flow.selected);
  assert.deepEqual(flashed, [['N0115', '22.2.0', 'stable']]);
});

test('outdated: nothing cached for that model: a message, never a flash', async () => {
  const { flow, flashed } = newFlow({ N0110: { versions: [] } });
  await flow.chooseModel('N0110');
  assert.equal(flow.step, 'none');
  assert.equal(await flow.confirm(undefined), false);
  assert.deepEqual(flashed, []);
  const failing = new OutdatedFlow({ loadInfo: async () => { throw new Error('server down'); }, flash: async () => assert.fail('flashed') });
  await failing.chooseModel('N0115');
  assert.equal(failing.step, 'error');
  assert.equal(await failing.confirm('x'), false);
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(app, /f\.step === 'none' \? t\('od\.none'/, 'the page says so');
});

test('outdated: Skip update shows the same very big warning and never flashes', async () => {
  const { flow, flashed } = newFlow();
  await flow.chooseModel('N0110');
  assert.equal(flow.skip(), true);
  assert.equal(flow.step, 'skipped');
  await flow.chooseModel('N0110');
  assert.equal(flow.step, 'skipped', 'stays skipped');
  assert.equal(flow.select('19.5.1'), false);
  assert.equal(await flow.confirm('19.5.1'), false);
  assert.deepEqual(flashed, []);
  const fresh = newFlow();
  assert.equal(fresh.flow.skip(), true, 'skipping before picking a model works too');
  assert.equal(await fresh.flow.confirm('26.4.0'), false);
  assert.deepEqual(fresh.flashed, []);
  // the page: the same banner element, its outdated text, after a skip
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(app, /const which = st\.refused \|\| limitedView\(\{ connected: !!st\.info, limited: st\.info\?\.limited, outdatedStep: st\.outdated\?\.step, dismissed: st\.warned \}\)\.warning;/);
  assert.match(fs.readFileSync(pub('index.html'), 'utf8'), /<button id="od-skip"[^>]*data-i18n="od\.skip">Skip update<\/button>/);
});

test('outdated: the page asks for the model with the back-of-the-calculator hint and confirms before any write', () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8'), app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(html, /data-model="N0110"/);
  assert.match(html, /data-model="N0115"/);
  assert.match(html, /data-i18n="od\.hint"/);
  assert.match(app, /if \(!await confirmDialog\(T\('od\.confirm', \{ version, model \}\)\)\) return;\s*await job\('update', async \(\) => \{\s*if \(st\.outdated !== f\) return;\s*await f\.confirm\(version\);/,
    'the dialog first, then the flow\'s confirm of that version');
  assert.ok(!/\.confirm\(/.test(app.replace(/f\.confirm\(version\)/, '')), 'no other path to the flow\'s confirm');
});

test('skipped: the warning once, OK dismisses it, then the normal page; a new connection warns again', () => {
  const v = (step, dismissed) => limitedView({ connected: true, limited: 'outdated', outdatedStep: step, dismissed });
  assert.deepEqual(v('model', false), { warning: null, normal: false, outdatedFlow: true }, 'before skipping: the update step');
  assert.deepEqual(v('version', false), { warning: null, normal: false, outdatedFlow: true });
  assert.deepEqual(v('skipped', false), { warning: 'outdated', normal: false, outdatedFlow: false }, 'skipped: the warning');
  assert.deepEqual(v('skipped', true), { warning: null, normal: true, outdatedFlow: false }, 'after OK: the normal page, no warning');
  assert.deepEqual(limitedView({ connected: true }), { warning: null, normal: true, outdatedFlow: false }, 'a calculator on recent firmware: as before');
  assert.deepEqual(limitedView({ connected: false }), { warning: null, normal: false, outdatedFlow: false });
  const app = fs.readFileSync(pub('app.js'), 'utf8'), html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<button id="big-warning-ok"[^>]*data-i18n="warn\.ok">OK<\/button>/);
  assert.match(app, /\$\('#big-warning-ok'\)\.addEventListener\('click', \(\) => \{\s*st\.warned = true;/, 'OK dismisses');
  assert.match(app, /st\.warned = false;\s*\/\/ \(the very big warning: once per connection/, 'reset on each connection');
  assert.match(app, /const full = view\.normal;\s*\$\('#s-apps'\)\.hidden = \$\('#s-new'\)\.hidden = \$\('#s-fw'\)\.hidden = !full;/, 'normal sections follow the view');
});

test('skipped: after OK, what can\'t work on that firmware says so; firmware still only through the confirm step', async () => {
  assert.equal(limitedActionError().code, 'limited.outdated');
  assert.equal(limitedFirmwareError('outdated', null).code, 'limited.outdatedFw', 'Check for updates: its own step only');
  assert.throws(() => limitedFirmwareError('outdated', 'N0100'), (e) => e.code === 'calc.n0100.noFlash', 'and never the N0100');
  assert.equal(limitedFirmwareError(null, 'N0120'), null);
  // a skipped flow never flashes, OK or not
  const { flow, flashed } = newFlow();
  await flow.chooseModel('N0110');
  flow.skip();
  assert.equal(await flow.confirm(flow.selected), false);
  assert.deepEqual(flashed, []);
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  for (const [what, re] of [
    ['Back up apps', /\$\('#backup-apps'\)\.addEventListener\('click', \(\) => job\('backup', async \(\) => \{\s*if \(st\.info\.limited\) throw limitedActionError/],
    ['Back up files', /\$\('#backup-files'\)\.addEventListener\('click', \(\) => job\('backup', async \(\) => \{\s*if \(st\.info\.limited\) throw limitedActionError/],
    ['Restore', /if \(!f\) return;\s*if \(st\.info\?\.limited\) \{ failLimited\('restore'\); return; \}/],
    ['Install', /\$\('#install'\)\.addEventListener\('click', async \(\) => \{\s*if \(st\.info\?\.limited\) \{ failLimited\('install'\); return; \}/],
    ['Check for updates', /if \(st\.info\.limited\) throw limitedFirmwareError\(st\.info\.limited, st\.info\.model\);/],
  ]) assert.match(app, re, what);
});

// ------------------------------------------------------------------ everything else as before
test('unchanged: Epsilon 16+ N0110/N0115/N0120, the Portugal prototype and the N0200 are not limited', () => {
  for (const [model, bcd, mem] of [['N0110', 0x0110, MEM.N0110], ['N0115', 0x0115, MEM.N0110], ['N0120', 0x0120, MEM.N0120]]) assert.deepEqual(detect(usbDev(bcd), mem), { model });
  assert.deepEqual(detect(usbDev(0x0120, 'NumWorks Calculator', 'EAAbABVROTUxNDM4'), MEM.N0120), { model: 'N0120_PORTUGAL_PROTOTYPE_20210930' });
  assert.deepEqual(detect(usbDev(0x0200, 'NumWorks Scientific Calculator'), []), { model: 'N0200' });
  assert.deepEqual(detect(usbDev(0x0130), MEM.N0120), { refuse: 'calc.unknownModel', bcd: '1.3.0' });
});

// ------------------------------------------------------------------ EN / FR
test('i18n: every new string in English and French, translated', async () => {
  const en = (await import('../public/i18n/en.js')).default, fr = (await import('../public/i18n/fr.js')).default;
  const keys = Object.keys(en).filter((k) => /^(warn\.|od\.|sim\.|limited\.|apps\.unavailable$|model\.outdated$|progress\.simulating$|err\.(calc\.n0100|gate\.|sim\.|limited\.))/.test(k));
  assert.ok(keys.length >= 30, 'found ' + keys.length);
  const same = ['od.opt', 'sim.what.n0100', 'warn.ok'];  // (only a version or a model number)
  for (const k of keys) {
    assert.ok(typeof fr[k] === 'string' && fr[k].trim(), 'fr: ' + k);
    if (!same.includes(k)) assert.notEqual(fr[k], en[k], 'fr translated: ' + k);
  }
  for (const k of Object.keys(fr)) assert.ok(k in en, 'en: ' + k);
  assert.equal(fr['od.hint'], 'Le modèle exact est indiqué au dos de la calculatrice (par ex. N0110 ou N0115).');
  for (const k of ['warn.n0100.body', 'warn.outdated.body']) assert.ok(!/'/.test(fr[k]), 'French apostrophes as in the rest of fr.js: ' + k);
  assert.match(en['warn.n0100.body'], /too old: it has no storage for \.nwa apps, and NumWorks itself has stopped updating the N0100/);
  assert.match(fr['warn.n0100.body'], /trop ancien : il n’a pas de place pour les applis \.nwa, et NumWorks elle-même a cessé de mettre à jour la N0100/);
});

// ------------------------------------------------------------------ TEST MODE (simulate.js)
test('simulation: each simulated calculator reaches its screen', async () => {
  assert.deepEqual(SIMULATED_IDS, SIMULATIONS);
  await assert.rejects(readInfo(simulatedDevice('n0100')), (e) => e.code === 'calc.n0100', 'the N0100: its refusal');
  for (const id of ['n0110-old', 'n0115-old']) {
    const i = await readInfo(simulatedDevice(id));
    assert.equal(i.limited, 'outdated', id);
    // the outdated flow on the simulated versions: the screen with the oldest picked
    const flow = new OutdatedFlow({ loadInfo: async (m) => ({ versions: SIMULATED_VERSIONS[m] }), flash: async () => assert.fail('real') });
    await flow.chooseModel(simulatedModel(id));
    assert.equal(flow.step, 'version', id);
    assert.equal(flow.selected, cachedVersions({ versions: SIMULATED_VERSIONS[simulatedModel(id)] })[0].version);
  }
  assert.throws(() => simulatedDevice('n0120'), (e) => e.code === 'sim.unknown');
});

test('simulation: a simulated confirm never touches the real flasher', async () => {
  let realCalls = 0;
  const real = async () => { realCalls++; };
  const flash = pickFlasher({ simulate: 'n0110-old', real, simulated: (m, o) => simulatedFlash(m, o, () => {}, { steps: 3, ms: 1 }) });
  assert.notEqual(flash, real);
  const flow = new OutdatedFlow({ loadInfo: async (m) => ({ versions: SIMULATED_VERSIONS[m] }), flash });
  await flow.chooseModel('N0110');
  await flow.confirm(flow.selected);
  assert.equal(flow.step, 'done');
  assert.deepEqual(flow.result, { simulated: true, model: 'N0110', version: '19.5.1' });
  assert.equal(realCalls, 0);
  assert.equal(pickFlasher({ simulate: null, real }), real, 'no simulation: the real one');
  assert.throws(() => pickFlasher({ simulate: 'n0100', real }), (e) => e.code === 'sim.noWrite', 'a simulation without its fake flasher gets nothing, never the real one');
  // the simulated device itself refuses every write, and has no USB behind it
  const d = simulatedDevice('n0115-old');
  assert.throws(() => d.write(0x90000000, new Uint8Array(4)), (e) => e.code === 'sim.noWrite');
  assert.throws(() => d.program(0x90000000, new Uint8Array(4)), (e) => e.code === 'sim.noWrite');
  const src = fs.readFileSync(pub('lib', 'simulate.js'), 'utf8');
  assert.ok(!/navigator\.usb|new Dfu|from '\.\/dfu\.js'/.test(src), 'no WebUSB in simulate.js');
  // and the page: the real flasher refuses in a simulation, the device is never a real Dfu then
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(app, /async function flashOutdated\(model, option\) \{\s*if \(SIM \|\| st\.dfu\?\.simulated\) throw/);
  assert.match(app, /st\.dfu = SIM \? sim\.simulatedDevice\(SIM\) :/);
  assert.match(app, /if \(MOCK \|\| SIM\) return connect\(null\);/, 'no USB device picker in a simulation');
  assert.match(app, /if \(SIM\) \$\('#sim-badge'\)\.hidden = false;/, 'the badge');
});

// ------------------------------------------------------------------ the developer-feature gate (env.js, NODE_ENV)
test('gate: NODE_ENV=production ignores ?mock, ?debug and ?simulate; any other NODE_ENV honours them', () => {
  const all = '?mock&debug&simulate=n0100';
  assert.equal(isDevEnv('production'), false);
  for (const s of [all, '?mock', '?debug', '?debug&simulate=n0110-old', '?debug&simulate=n0115-old'])
    assert.deepEqual({ ...parseDevFlags(s, isDevEnv('production')) }, { mock: false, debug: false, simulate: null }, s);
  for (const env of ['development', 'test', undefined]) assert.equal(isDevEnv(env), true, String(env));
  const dev = (s) => ({ ...parseDevFlags(s, isDevEnv('development')) });
  assert.deepEqual(dev(''), { mock: false, debug: false, simulate: null }, 'no flag: nothing');
  assert.deepEqual(dev('?mock'), { mock: true, debug: false, simulate: null });
  assert.deepEqual(dev('?debug'), { mock: false, debug: true, simulate: null });
  for (const id of SIMULATIONS) assert.deepEqual(dev('?debug&simulate=' + id), { mock: false, debug: true, simulate: id });
  assert.equal(dev('?simulate=n0100').simulate, null, 'a simulation needs ?debug too');
  assert.equal(dev('?debug&simulate=n0120').simulate, null, 'only known simulations');
  assert.equal(dev(all).mock, false, 'a simulation replaces the mock');
});

test('gate: the page reads its flags only through env.js', () => {
  for (const f of ['app.js', 'numplay-ui.js']) {
    const src = fs.readFileSync(pub(f), 'utf8');
    assert.ok(!/location\.search|URLSearchParams/.test(src), f + ' parses no URL flags itself');
  }
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(app, /const \{ mock: MOCK, debug: DEBUG, simulate: SIM \} = devFlags\(\);/);
  assert.ok(!/^import [^\n]*simulate\.js/m.test(app), 'simulate.js only imported for a simulation (dynamically)');
  assert.ok(!/^import [^\n]*mockdfu/m.test(app), 'the mock only imported for ?mock (dynamically)');
  const env = fs.readFileSync(pub('lib', 'env.js'), 'utf8');
  assert.match(env, /import \{ NODE_ENV \} from '\.\/build-mode\.js';/);
  assert.match(fs.readFileSync(pub('lib', 'build-mode.js'), 'utf8'), /export const NODE_ENV = 'production';/, 'the static copy is safe: production');
});

// spawns server.js with this NODE_ENV and fetches these paths -> { path: { status, body } }
async function serve(nodeEnv, paths) {
  const port = 20642 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, NWA_FW_SCHEDULE: '0', NUMWORKS_ACCOUNT: path.join(repo, 'no-such-account.json') };
  delete env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const server = spawn(process.execPath, [path.join(repo, 'server.js'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env });
  try {
    await new Promise((ok) => server.stdout.once('data', ok));
    const out = {};
    for (const p of paths) {
      const r = await fetch(`http://localhost:${port}${p}`);
      out[p] = { status: r.status, body: await r.text() };
    }
    return out;
  } finally { server.kill(); }
}
const PATHS = ['/lib/build-mode.js', '/lib/simulate.js', '/lib/./simulate.js', '/LIB/Simulate.js', '/dev/mockdfu.js', '/dev/mock/fw.json', '/lib/env.js', '/app.js', '/'];
// what the page would decide from what the server sent
const flagsFrom = (buildModeJs, search) => {
  const nodeEnv = /export const NODE_ENV = "([^"]*)";/.exec(buildModeJs)?.[1];
  return { ...parseDevFlags(search, isDevEnv(nodeEnv)) };
};

test('server: NODE_ENV=production tells the page so, and serves no mock or simulation code', async () => {
  const r = await serve('production', PATHS);
  assert.equal(r['/lib/build-mode.js'].status, 200);
  assert.equal(r['/lib/build-mode.js'].body, 'export const NODE_ENV = "production";\n');
  for (const p of ['/lib/simulate.js', '/lib/./simulate.js', '/LIB/Simulate.js', '/dev/mockdfu.js', '/dev/mock/fw.json']) assert.equal(r[p].status, 404, p);
  for (const p of ['/lib/env.js', '/app.js', '/']) assert.equal(r[p].status, 200, p);
  assert.deepEqual(flagsFrom(r['/lib/build-mode.js'].body, '?mock&debug&simulate=n0100'), { mock: false, debug: false, simulate: null });
});

test('server: NODE_ENV=development (or unset) enables them', async () => {
  for (const nodeEnv of ['development', undefined]) {
    const r = await serve(nodeEnv, PATHS);
    assert.equal(r['/lib/build-mode.js'].body, 'export const NODE_ENV = "development";\n', String(nodeEnv));
    for (const p of ['/lib/simulate.js', '/dev/mockdfu.js', '/dev/mock/fw.json']) assert.equal(r[p].status, 200, `${nodeEnv}: ${p}`);
    assert.deepEqual(flagsFrom(r['/lib/build-mode.js'].body, '?debug&simulate=n0110-old'), { mock: false, debug: true, simulate: 'n0110-old' });
    assert.deepEqual(flagsFrom(r['/lib/build-mode.js'].body, '?mock'), { mock: true, debug: false, simulate: null });
  }
});

// ------------------------------------------------------------------ run
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
console.log(`gate: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
