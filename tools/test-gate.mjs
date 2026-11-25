// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the half-supported calculators (public/lib/gate.js), the TEST MODE (public/lib/simulate.js) and the one gate
// for every developer feature (public/lib/env.js, fed by server.js from NODE_ENV). No network, no calculator:
//  - the N0100 and every other connect-time refusal: a pop-up (modal dialog, OK/Esc), then not connected; nothing read
//    from the N0100, never any firmware (assertFirmwareAllowed)
//  - an N0110/N0115 on outdated firmware: model asked, every cached version listed oldest first with the oldest picked,
//    nothing flashed before an explicit confirm of the version shown, then exactly that one; Cancel never flashes;
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

const { OutdatedFlow, OUTDATED_MODELS, assertFirmwareAllowed, cachedVersions, pickFlasher, limitedView, refusalOf } = await import('../public/lib/gate.js');
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
  assert.equal(refusalOf('calc.n0100').title, 'warn.n0100.title', 'its own title in the pop-up');
  assert.match(app, /const refusal = refusalOf\(e\.code\);\s*if \(refusal\) \{\s*status\(\(\) => errText\(e\), 'warn'\);\s*showNotice\(\{ kind: 'refusal', title: T\(refusal\.title\), text: \(\) => errText\(e\), onClose: \(\) => \{ status\(T\('connect\.hint'\)\); render\(\); \} \}\);/,
    'a refusal: the pop-up, then back to not connected');
  assert.match(app, /if \(!st\.info\) return;\s*assertFirmwareAllowed\(st\.info\.model\);/, 'Check for updates guarded');
  assert.match(app, /if \(!i \|\| i\.limited \|\| !p\?\.available\) return;\s*try \{ assertFirmwareAllowed\(i\.model\); \}/, 'Update guarded');
  assert.match(app, /async function flashOutdated\(model, option\) \{[^]*?assertFirmwareAllowed\(model\);/, 'the outdated flasher guarded');
  const css = fs.readFileSync(pub('style.css'), 'utf8');
  assert.match(css, /dialog\.notice \{/);
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
  assert.equal(flow.cancel(), false, 'too late to cancel');
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

test('outdated: no Skip update any more; Cancel never flashes, then or later', async () => {
  const { flow, flashed } = newFlow();
  assert.equal(typeof flow.skip, 'undefined', 'no skip path');
  await flow.chooseModel('N0110');
  assert.equal(flow.cancel(), true);
  assert.equal(flow.step, 'cancelled');
  await flow.chooseModel('N0110');
  assert.equal(flow.step, 'cancelled', 'stays cancelled');
  assert.equal(flow.select('19.5.1'), false);
  assert.equal(await flow.confirm('19.5.1'), false);
  assert.deepEqual(flashed, []);
  const fresh = newFlow();
  assert.equal(fresh.flow.cancel(), true, 'before picking a model too');
  assert.equal(await fresh.flow.confirm('26.4.0'), false);
  assert.deepEqual(fresh.flashed, []);
  // the page: Cancel lets the calculator go and is back to not connected, no warning, no app sections
  const app = fs.readFileSync(pub('app.js'), 'utf8'), html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.ok(!/od-skip|od\.skip|warn\.outdated|st\.warned|kind: 'outdated'/.test(app + html), 'nothing left of the skip path');
  assert.match(html, /<button id="od-cancel" class="ghost" type="button" data-i18n="dlg\.cancel">Cancel<\/button>/);
  assert.match(app, /\$\('#od-cancel'\)\.addEventListener\('click', async \(\) => \{\s*if \(!st\.outdated\?\.cancel\(\)\) return;\s*log\('Update cancelled: nothing written\.'\);\s*await st\.dfu\?\.close\(\)\.catch\(\(\) => \{\}\);\s*st\.dev = st\.dfu = st\.info = st\.scan = st\.outdated = null;\s*status\(T\('connect\.hint'\)\);\s*render\(\);/);
  const cancel = /\$\('#od-cancel'\)[^]*?\n\}\);/.exec(app)[0];
  assert.ok(!/write|flash|program|confirm/i.test(cancel.replace(/cancel/gi, '')), 'Cancel writes nothing');
});

test('outdated: the page asks for the model with the back-of-the-calculator hint and confirms before any write', () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8'), app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(html, /data-model="N0110"/);
  assert.match(html, /data-model="N0115"/);
  assert.match(html, /data-i18n="od\.hint"/);
  assert.match(html, /data-i18n="od\.sub">This calculator runs Epsilon 15 or older, which has no space for \.nwa apps \(they need Epsilon 16 or later\), so it must be updated first\./);
  assert.match(app, /if \(!await confirmDialog\(T\('od\.confirm', \{ version, model \}\)\)\) return;\s*await job\('update', async \(\) => \{\s*if \(st\.outdated !== f\) return;\s*await f\.confirm\(version\);/,
    'the dialog first, then the flow\'s confirm of that version');
  assert.ok(!/\.confirm\(/.test(app.replace(/f\.confirm\(version\)/, '')), 'no other path to the flow\'s confirm');
});

test('outdated: only its update step is shown, never the app sections; other calculators as before', () => {
  assert.deepEqual(limitedView({ connected: true, limited: 'outdated' }), { normal: false, outdatedFlow: true });
  assert.deepEqual(limitedView({ connected: true }), { normal: true, outdatedFlow: false }, 'Epsilon 16 or later: as before');
  assert.deepEqual(limitedView({ connected: false }), { normal: false, outdatedFlow: false });
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.match(app, /const full = view\.normal;\s*\$\('#s-apps'\)\.hidden = \$\('#s-new'\)\.hidden = \$\('#s-fw'\)\.hidden = !full;/, 'app sections hidden');
  assert.ok(!/renderLimited|failLimited|limitedActionError|limitedFirmwareError/.test(app), 'no greyed-out app page left');
  // the actions themselves still do nothing on it, if ever reached
  for (const [what, re] of [
    ['Back up apps', /\$\('#backup-apps'\)\.addEventListener\('click', \(\) => job\('backup', async \(\) => \{\s*if \(st\.info\.limited\) return;/],
    ['Back up files', /\$\('#backup-files'\)\.addEventListener\('click', \(\) => job\('backup', async \(\) => \{\s*if \(st\.info\.limited\) return;/],
    ['Restore', /if \(!f\) return;\s*if \(st\.info\?\.limited\) return;/],
    ['Install', /\$\('#install'\)\.addEventListener\('click', async \(\) => \{\s*if \(st\.info\?\.limited\) return;/],
    ['Check for updates', /assertFirmwareAllowed\(st\.info\.model\);\s*if \(st\.info\.limited\) return;/],
  ]) assert.match(app, re, what);
});

test('pop-up: every connect-time refusal is one; other errors are not', () => {
  for (const c of ['calc.n0100', 'calc.tooOld', 'calc.updateFirst', 'calc.unknownModel', 'calc.unofficial.thirdParty', 'calc.unofficial.upsilon',
    'calc.unofficial.omega', 'calc.unofficial.upsilonBootloader']) assert.ok(refusalOf(c), c);
  assert.equal(refusalOf('calc.tooOld').title, 'refuse.title');
  for (const c of ['connect.retry', 'calc.noKernel', 'limited.outdated', 'fw.check', undefined, null, 'calc.unofficial.']) assert.equal(refusalOf(c), null, String(c));
  // every refusal the page knows has its text in both languages
  const app = fs.readFileSync(pub('app.js'), 'utf8');
  assert.ok(!/calc\\\.\(tooOld\|n0100/.test(app), 'no second list of refusals in app.js');
  assert.match(app, /if \(refusalOf\(e\.code\)\) throw e;/, 'connect passes refusals through as they are');
});

test('pop-up: a modal dialog, labelled, with OK; Esc and OK close it; Tab stays in it; nothing written', () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8'), app = fs.readFileSync(pub('app.js'), 'utf8');
  const dlg = /<dialog id="notice"[^>]*>[^]*?<\/dialog>/.exec(html)?.[0] || '';
  assert.match(dlg, /aria-modal="true"/);
  assert.match(dlg, /aria-labelledby="notice-title"/);
  assert.match(dlg, /aria-describedby="notice-text"/);
  assert.match(dlg, /<form method="dialog">/, 'OK closes it (a dialog form), and Esc does too (a modal <dialog>)');
  assert.ok(!/<input|<select|<textarea/.test(dlg), 'nothing to fill in');
  assert.match(app, /d\.showModal\(\);\s*\$\('#notice-ok'\)\.focus\(\);/, 'modal (the page behind is inert), focus on OK');
  assert.match(app, /\$\('#notice'\)\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Tab'\) \{ e\.preventDefault\(\); \$\('#notice-ok'\)\.focus\(\); \}/, 'Tab trapped');
  assert.match(app, /\$\('#notice'\)\.addEventListener\('close', \(\) => \{\s*const n = st\.notice;\s*st\.notice = null;\s*n\?\.onClose\?\.\(\);/, 'every way of closing runs its onClose');
  // the pop-up's code writes nothing to a calculator
  const fn = /function showNotice[^]*?\n\}\r?\nfunction drawNotice[^]*?\n\}/.exec(app)?.[0] || '';
  assert.ok(fn && !/dfu|write|flash/i.test(fn), 'showNotice/drawNotice never touch the calculator');
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
  const keys = Object.keys(en).filter((k) => /^(warn\.|refuse\.|od\.|sim\.|limited\.|apps\.unavailable$|model\.outdated$|progress\.simulating$|err\.(calc\.n0100|gate\.|sim\.|limited\.))/.test(k));
  assert.ok(keys.length >= 30, 'found ' + keys.length);
  const same = ['od.opt', 'sim.what.n0100', 'warn.ok'];  // (only a version or a model number)
  for (const k of keys) {
    assert.ok(typeof fr[k] === 'string' && fr[k].trim(), 'fr: ' + k);
    if (!same.includes(k)) assert.notEqual(fr[k], en[k], 'fr translated: ' + k);
  }
  for (const k of Object.keys(fr)) assert.ok(k in en, 'en: ' + k);
  assert.equal(fr['od.hint'], 'Le modèle exact est indiqué au dos de la calculatrice (par ex. N0110 ou N0115).');
  for (const k of ['err.calc.n0100', 'od.sub', 'refuse.title']) assert.ok(!/'/.test(fr[k]), 'French apostrophes as in the rest of fr.js: ' + k);
  assert.match(en['err.calc.n0100'], /too old for Nwa Toolkit: it has no storage for \.nwa apps, and NumWorks has stopped updating it/);
  assert.match(fr['err.calc.n0100'], /trop ancienne pour Nwa Toolkit : elle n’a pas de place pour les applis \.nwa, et NumWorks a cessé de la mettre à jour/);
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

// ------------------------------------------------------------------ the theme (Catppuccin Latte / Mocha)
// the official palettes (catppuccin.com), to check style.css against
const CTP = {
  latte: { rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39', maroon: '#e64553', peach: '#fe640b',
    yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd', text: '#4c4f69',
    subtext1: '#5c5f77', subtext0: '#6c6f85', overlay2: '#7c7f93', overlay1: '#8c8fa1', overlay0: '#9ca0b0', surface2: '#acb0be', surface1: '#bcc0cc',
    surface0: '#ccd0da', base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8' },
  mocha: { rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387',
    yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe', text: '#cdd6f4',
    subtext1: '#bac2de', subtext0: '#a6adc8', overlay2: '#9399b2', overlay1: '#7f849c', overlay0: '#6c7086', surface2: '#585b70', surface1: '#45475a',
    surface0: '#313244', base: '#1e1e2e', mantle: '#181825', crust: '#11111b' },
};
const css = () => fs.readFileSync(pub('style.css'), 'utf8').replace(/\/\*[^]*?\*\//g, '');
// the custom properties declared in the first block whose selector is exactly sel
const block = (src, sel, nth = 0) => {
  const re = new RegExp(sel.replace(/[[\]().*"=:]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  const m = [...src.matchAll(re)][nth];
  assert.ok(m, 'no block ' + sel);
  return Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
};
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// a colour value as the browser computes it: var(), color-mix(in srgb, A p%, B) (alpha ignored: only used on opaque pairs)
function resolve(v, vars, depth = 0) {
  assert.ok(depth < 20, 'loop at ' + v);
  v = v.trim();
  let m;
  if ((m = /^var\((--[\w-]+)\)$/.exec(v))) { assert.ok(m[1] in vars, 'undefined ' + m[1]); return resolve(vars[m[1]], vars, depth + 1); }
  if (/^#[0-9a-f]{6}$/i.test(v)) return rgbOf(v);
  if ((m = /^color-mix\(in srgb, (.+?) (\d+)%, (.+)\)$/.exec(v))) {
    const a = resolve(m[1], vars, depth + 1), p = +m[2] / 100, b = m[3] === 'transparent' ? null : resolve(m[3], vars, depth + 1);
    return b ? a.map((x, i) => x * p + b[i] * (1 - p)) : a;
  }
  throw new Error('cannot resolve ' + v);
}
const luminance = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// every theme's variables: Latte is :root; Mocha is :root[data-theme="mocha"] (and the same under prefers dark); the
// roles (second :root block) on top of either
function themeVars(flavour) {
  const src = css();
  const latte = block(src, ':root', 0), roles = block(src, ':root', 1);
  const mocha = block(src, ':root[data-theme="mocha"]');
  return flavour === 'latte' ? { ...latte, ...roles } : { ...latte, ...mocha, ...roles };
}

test('theme: style.css uses only the official Latte and Mocha palettes, as --ctp-* variables', () => {
  const src = css();
  for (const flavour of ['latte', 'mocha']) {
    const v = themeVars(flavour);
    for (const [name, hexv] of Object.entries(CTP[flavour])) assert.equal(v['--ctp-' + name]?.toLowerCase(), hexv, `${flavour} ${name}`);
  }
  // the same Mocha under prefers-color-scheme: dark (unless Latte was picked) as under data-theme="mocha"
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="latte"\]\) \{([^}]*)\}\s*\}/.exec(src);
  assert.ok(dark, 'Mocha follows a dark system');
  assert.deepEqual(Object.fromEntries([...dark[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()])), block(src, ':root[data-theme="mocha"]'));
  // no colour anywhere else: no hex outside a --ctp-* declaration, no rgb()/hsl(), no named colours
  const palette = new Set(Object.values(CTP).flatMap((p) => Object.values(p)));
  for (const m of src.matchAll(/([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const [, prop, value] = m;
    if (/^--ctp-/.test(prop)) { assert.ok(palette.has(value.trim().toLowerCase()), `${prop}: ${value} is not a Catppuccin colour`); continue; }
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(value), `${prop}: ${value}: a colour outside the palette variables`);
    assert.ok(!/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(value), `${prop}: ${value}`);
    if (!/^(white-space|font|font-family|display|text-transform|content|list-style|outline-style)$/.test(prop))
      assert.ok(!/(^|[\s,(])(white|black|red|orange|yellow|green|blue|gray|grey|silver|purple|pink|brown)([\s,)]|$)/i.test(value), `${prop}: ${value}: a named colour`);
    for (const mix of value.matchAll(/color-mix\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) assert.match(mix[1], /^in srgb, var\(--[\w-]+\) \d+%, (var\(--[\w-]+\)|transparent)$/, value);
  }
  // nor in the page and its scripts
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  for (const m of html.matchAll(/%23([0-9a-f]{3,6})/gi)) assert.ok(palette.has('#' + m[1].toLowerCase()), 'favicon colour #' + m[1]);
  assert.ok(!/\sstyle="/.test(html));
  for (const f of ['app.js', 'numplay-ui.js']) {
    const js = fs.readFileSync(pub(f), 'utf8');
    assert.ok(!/['"`]#[0-9a-f]{3,8}['"`]|rgba?\(/i.test(js), f + ': no colour in the code');
  }
});

test('theme: text stays readable in Latte and Mocha (WCAG 4.5:1)', () => {
  const pairs = [
    ['body text', 'var(--text)', 'var(--card)'], ['body text, inner panels', 'var(--text)', 'var(--card-2)'], ['body text, page', 'var(--text)', 'var(--bg)'],
    ['muted text', 'var(--muted)', 'var(--card)'], ['muted text, inner panels', 'var(--muted)', 'var(--card-2)'], ['footer', 'var(--muted)', 'var(--bg)'],
    ['success', 'var(--ok-text)', 'var(--card)'], ['success, inner panels', 'var(--ok-text)', 'var(--card-2)'],
    ['error', 'var(--bad-text)', 'var(--card)'], ['error, inner panels', 'var(--bad-text)', 'var(--card-2)'],
    ['warning', 'var(--warn-text)', 'var(--card)'], ['warning, inner panels', 'var(--warn-text)', 'var(--card-2)'],
    ['links', 'var(--accent-text)', 'var(--card)'], ['links, inner panels', 'var(--accent-text)', 'var(--card-2)'], ['tags', 'var(--accent-text)', 'var(--accent-soft)'],
    ['code and picked tiles', 'var(--text)', 'var(--accent-soft)'],
    ['primary buttons', 'var(--on-accent)', 'var(--accent)'], ['Write it (danger)', 'var(--on-accent)', 'var(--ctp-red)'],
    ['refusal pop-up', 'var(--ctp-text)', 'color-mix(in srgb, var(--ctp-red) 16%, var(--ctp-base))'],
    ['test-mode badge', 'var(--sim-label-fg)', 'var(--sim-label-bg)'],
    ['progress label on the track', 'var(--text)', 'var(--free)'], ['progress label on the fill', 'var(--text)', 'color-mix(in srgb, var(--accent) 30%, var(--ctp-base))'],
    ['app badges', 'var(--text)', 'var(--ctp-surface0)'],
  ];
  const report = [];
  for (const flavour of ['latte', 'mocha']) {
    const v = themeVars(flavour);
    for (const [what, fg, bg] of pairs) {
      const c = contrast(resolve(fg, v), resolve(bg, v));
      report.push(`${flavour} ${what}: ${c.toFixed(2)}`);
      assert.ok(c >= 4.5, `${flavour}, ${what}: ${c.toFixed(2)}:1 is under 4.5:1`);
    }
  }
  // (the CSS really uses these roles where it says)
  const src = css();
  assert.match(src, /#status\.warn, \.warn \{ color: var\(--bad-text\); \}/);
  assert.match(src, /#status\.ok \{ color: var\(--ok\);/);
  assert.match(src, /dialog\.notice \{ --notice: var\(--ctp-red\);[^}]*background: color-mix\(in srgb, var\(--notice\) 16%, var\(--ctp-base\)\); color: var\(--ctp-text\); \}/);
  if (process.env.CONTRAST) console.log(report.join('\n'));
});

test('theme: Auto follows the system; Latte or Mocha picked is kept; Auto forgets it', async () => {
  const vm = await import('vm');
  const src = fs.readFileSync(pub('theme.js'), 'utf8');
  const run = (stored) => {
    const store = new Map(stored ? [['nwa.theme', stored]] : []);
    const attrs = new Map(), listeners = {};
    const sel = { value: '', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
    const ctx = {
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) },
        addEventListener: (t, f) => { listeners[t] = f; }, getElementById: (id) => (id === 'theme' ? sel : null) },
    };
    vm.runInNewContext(src, ctx);
    listeners.DOMContentLoaded();
    return { store, attrs, sel, pick: (v) => { sel.value = v; sel.listeners.change(); } };
  };
  let r = run(null);
  assert.equal(r.attrs.get('data-theme'), undefined, 'nothing saved: Auto (the system decides)');
  assert.equal(r.sel.value, 'auto');
  r.pick('mocha');
  assert.equal(r.attrs.get('data-theme'), 'mocha');
  assert.equal(r.store.get('nwa.theme'), 'mocha', 'remembered');
  r = run('latte');
  assert.equal(r.attrs.get('data-theme'), 'latte', 'a saved choice wins over the system');
  assert.equal(r.sel.value, 'latte');
  r.pick('auto');
  assert.equal(r.attrs.get('data-theme'), undefined);
  assert.ok(!r.store.has('nwa.theme'), 'Auto clears the override');
  r = run('frappe');
  assert.equal(r.attrs.get('data-theme'), undefined, 'only Latte and Mocha');
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="style\.css">\s*<script src="theme\.js"><\/script>/, 'set before the page is drawn');
  assert.match(html, /<select id="theme"[^>]*data-i18n-aria-label="theme\.label">\s*<option value="auto" data-i18n="theme\.auto">[^<]*<\/option>\s*<option value="latte" data-i18n="theme\.latte">[^<]*<\/option>\s*<option value="mocha" data-i18n="theme\.mocha">/);
  const en = (await import('../public/i18n/en.js')).default, fr = (await import('../public/i18n/fr.js')).default;
  for (const k of ['theme.label', 'theme.auto', 'theme.latte', 'theme.mocha']) assert.ok(en[k] && fr[k], k);
});

// ------------------------------------------------------------------ the name
test('name: Nwa Toolkit everywhere, the old name nowhere', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'nwa-toolkit');
  const en = (await import('../public/i18n/en.js')).default, fr = (await import('../public/i18n/fr.js')).default;
  assert.equal(en['app.title'], 'Nwa Toolkit');
  assert.equal(fr['app.title'], 'Nwa Toolkit');
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<title>Nwa Toolkit<\/title>/);
  assert.match(html, /href="https:\/\/github\.com\/SkyExploreWasTaken\/nwa-toolkit"/, 'the source link points at the renamed repository');
  const files = ['README.md', 'package.json', 'server.js', 'numworks.js', 'numplay.js', 'firmware-cache.js', 'serve.bat',
    ...fs.readdirSync(path.join(repo, 'tools')).map((f) => 'tools/' + f),
    ...['index.html', 'app.js', 'numplay-ui.js', 'theme.js', 'i18n/en.js', 'i18n/fr.js', ...fs.readdirSync(pub('lib')).map((f) => 'lib/' + f)].map((f) => 'public/' + f)];
  for (const f of files) {
    if (f === 'tools/test-gate.mjs') continue;
    const src = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.ok(!/nwa[ _-]?installer|this installer|cet installateur/i.test(src), f + ' still has the old name');
  }
});

// ------------------------------------------------------------------ run
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
console.log(`gate: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
