// SPDX-License-Identifier: GPL-3.0-or-later
// The page: connect over WebUSB, show what's on the calculator, add .nwa files, install.
// Text the page shows comes from i18n/ (t()); the log stays in English, for bug reports. Everything this file draws
// is kept as a function of the state (status, progress, firmware note, the confirm dialog), so switching language
// redraws it in place: see 'langchange' at the end.
import { Dfu } from './lib/dfu.js';
import { readInfo, scanApps, parseAppHeader, hex, SECTOR, SLOT_B } from './lib/calc.js';
import { loadTools, inspectNwa } from './lib/link.js';
import { planInstall, writeInstall } from './lib/install.js';
import { parseStorage, buildStorage, recordSize, MAX_RECORD } from './lib/storage.js';
import { firmwareChoices } from './lib/fwchoice.js';
import { parseDfuFile, writableElements } from './lib/dfufile.js';
import { InstallerError } from './lib/errors.js';
import { initNumPlay } from './numplay-ui.js';
import { devFlags } from './lib/env.js';
import { isAndroid, PICKABLE } from './lib/model.js';
import { loadSiteFont } from './lib/sitefont.js';
import { OutdatedFlow, assertFirmwareAllowed, pickFlasher, limitedView, refusalOf } from './lib/gate.js';
import { t, errText, size as kb, mb, applyDom, initLangSelect, getLang } from './i18n/index.js';

const $ = (s) => document.querySelector(s);
loadSiteFont();  // (the optional custom font from config.json: lib/sitefont.js)
applyDom();
initLangSelect($('#lang'));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const st = { dev: null, dfu: null, info: null, scan: null, queue: [], busy: false, status: null, fwSetup: null, outdated: null, notice: null };
const T = (key, vars) => () => t(key, vars);  // a text to draw now and again on a language change
// an error the page itself throws, with a code for its text (err.<code>) and the English message for the log
const uiError = (code, params, message, cause) => new InstallerError(code, params, message, cause ? { cause } : undefined);
// an error the local server sent: { error, code?, params? }
const serverError = (j, httpStatus) => j.code ? uiError(j.code, j.params || {}, j.error)
  : j.error ? new Error(j.error) : uiError('http', { status: httpStatus }, 'HTTP ' + httpStatus);

function log(msg) {
  const time = new Date().toLocaleTimeString();
  $('#log').textContent += `[${time}] ${msg}\n`;
  $('#log').scrollTop = 1e9;
}
// the line under "Calculator": text is a string or T(...), kept to redraw on a language change
function status(text, kind = '') { st.status = { text, kind }; drawStatus(); }
function drawStatus() {
  if (!st.status) return;  // (the page's own text until something happens)
  const s = $('#status'), { text, kind } = st.status;
  s.textContent = typeof text === 'function' ? text() : text;
  s.className = kind || 'muted';
}
// a progress bar: label is a key, given { pct } and vars
function progress(p, label = 'progress.pct', vars = {}, box = $('#progress')) {
  box.hidden = p == null;
  box._state = p == null ? null : { p, label, vars };
  drawProgress(box);
}
function drawProgress(box) {
  if (!box._state) return;
  const { p, label, vars } = box._state;
  box.querySelector('div').style.width = (p * 100).toFixed(1) + '%';
  box.querySelector('span').textContent = t(label, { ...vars, pct: Math.round(p * 100) });
}
function download(bytes, name) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const sectors = (n) => Math.ceil(n / SECTOR) * SECTOR;

// one USB job at a time; name: 'connect', 'backup', ... (fail.<name> is its error line)
async function job(name, fn) {
  if (st.busy) return;
  st.busy = true;
  render();
  try { return await fn(); } catch (e) {
    log(name + ' failed: ' + (e.message || e));
    // a calculator this page refuses (lib/gate.js refusalOf): a pop-up saying why, then back to not connected
    const refusal = refusalOf(e.code);
    if (refusal) {
      status(() => errText(e), 'warn');
      showNotice({ kind: 'refusal', title: T(refusal.title), text: () => errText(e), onClose: () => { status(T('connect.hint')); render(); } });
    } else status(() => t('fail.' + name, { msg: errText(e) }), 'warn');
    console.error(e);
  } finally { st.busy = false; render(); }
}

// ------------------------------------------------------------------ connecting
// the developer flags, only ever through lib/env.js's gate (all off when the server runs with NODE_ENV=production):
//  ?mock: a pretend calculator, for testing (dev/mockdfu.js)
//  ?debug: the page's state on window.nwaDebug, for reading the calculator from the console (read-only checks)
//  ?debug&simulate=n0100|n0110-old|n0115-old: TEST MODE, a simulated calculator (lib/simulate.js), never any USB
const { mock: MOCK, debug: DEBUG, simulate: SIM } = devFlags();
if (DEBUG) window.nwaDebug = st;
// (simulate.js only loaded for a simulation: in production the server doesn't even serve it)
const sim = SIM ? await import('./lib/simulate.js') : null;
if (SIM) $('#sim-badge').hidden = false;
// iPhone and iPad: no WebUSB in any of their browsers (they're all WebKit underneath). iPadOS says it's a Mac:
// a "Mac" with a touch screen is an iPad.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const NO_USB = !MOCK && !SIM && (IOS || !('usb' in navigator));
if (NO_USB) {
  status(T(IOS ? 'connect.ios' : 'connect.noWebUsb'), 'warn');
  $('#connect').disabled = true;
}

$('#connect').addEventListener('click', () => job('connect', async () => {
  if (MOCK || SIM) return connect(null);
  let dev;
  try { dev = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483 }] }); } catch (e) {
    if (e.name === 'NotFoundError') { status(T('connect.nonePicked')); return; }
    throw e;
  }
  await connect(dev);
}));

const ANDROID = isAndroid(navigator);
// showModal, or where a browser has none: the dialog shown with its `open` attribute (close() likewise, with the
// 'close' event), so the page works anywhere
function openDialog(d) {
  if (typeof d.showModal === 'function') return d.showModal();
  d.setAttribute('open', '');
  d.close = (rv) => { if (rv !== undefined) d.returnValue = rv; d.removeAttribute('open'); d.dispatchEvent(new Event('close')); };
  d.addEventListener('submit', (e) => { e.preventDefault(); d.close(e.submitter?.value ?? ''); }, { once: true });
}
// The model picker (<dialog id="which-model">): the known models as a list (name and a short description), the ones the
// calculator's memories contradict greyed out, and "My calculator is not here". -> the model, or null.
// (its id isn't "pick": that's the .nwa file input's, and the first match wins)
function askModel(allowed, bcd) {
  return new Promise((done) => {
    const d = $('#which-model');
    $('#pick-list').replaceChildren(...PICKABLE.map((m) => {
      const li = el('li');
      const b = el('button', 'model-row');
      b.type = 'submit';
      b.value = m;
      b.disabled = !allowed.includes(m);
      b.append(el('b', '', m), el('span', 'muted', t('pick.model.' + m)));
      if (b.disabled) b.append(el('span', 'model-no', t('pick.mismatch')));
      li.append(b);
      return li;
    }));
    $('#pick-text').textContent = t(ANDROID ? 'pick.textAndroid' : 'pick.text', { bcd });
    d.returnValue = '';
    d.addEventListener('close', () => done(allowed.includes(d.returnValue) ? d.returnValue : null), { once: true });
    openDialog(d);
  });
}

async function connect(dev) {
  if (st.dfu) await st.dfu.close();
  st.dev = dev;
  st.outdated = null;
  st.dfu = SIM ? sim.simulatedDevice(SIM) : MOCK ? await (await import('./dev/mockdfu.js')).mockDevice() : new Dfu(dev);
  try {
    await st.dfu.open();
    if (MOCK || SIM) dev = { productName: st.dfu.productName };
    status(T('connect.reading'));
    // On Android no auto-detection (its USB version can't be trusted: an N0120 shows as 1.1.4): the user picks the model.
    // Elsewhere only a version this page doesn't know asks. Every pick is checked against the calculator's memories
    // (lib/model.js). The software version is never asked: it's read from the calculator itself, as on a computer.
    try { st.info = await readInfo(st.dfu, { manual: ANDROID }); } catch (e) {
      if (e.code !== 'calc.unknownModel' || !e.pick?.length) throw e;
      const model = await askModel(e.pick, e.params.bcd);
      if (!model) throw e;
      st.info = await readInfo(st.dfu, { chosenModel: model, manual: ANDROID });
    }
  } catch (e) {
    // let go of the calculator, so a new try (or another program) can have it
    await st.dfu.close().catch(() => {});
    st.dev = st.dfu = st.info = st.scan = null;
    // (a calculator this page refuses: its own message, in a pop-up, without "unplug and connect again", which won't help)
    if (refusalOf(e.code)) throw e;
    throw uiError('connect.retry', {}, e.message + '. Unplug the calculator, plug it back in, unlock it, close other pages that use it (like my.numworks.com), then Connect again.', e);
  }
  if (st.info.limited) return connectLimited(dev);
  log(`DFU memories: ${(st.info.dfuStrings || []).join(' | ')}; software: ${st.info.firmwareCheck?.official ? 'official' : '?'}${st.info.firmwareCheck && !st.info.firmwareCheck.known ? ' (DFU string not one of the documented forms: allowed)' : ''}`);
  log(`Connected: ${st.info.model} (from its USB descriptor), Epsilon ${st.info.version} (${st.info.patch}), app area ${hex(st.info.appsStart)}–${hex(st.info.appsEnd)}`);
  await rescan();
  status(T('connect.ok', { name: dev.productName || 'NumWorks', model: modelLabel(st.info.model) }), 'ok');
  loadTools().catch((e) => log('Linker: ' + e.message));
}

// an N0110/N0115 on outdated firmware (lib/gate.js): nothing else read, only what gate.js allows
function connectLimited(dev) {
  const i = st.info;
  log(`DFU memories: ${st.dfu.layouts.map((l) => l.name).join(' | ')}`);
  log('Connected: an N0110 or N0115 on outdated firmware (USB version 1.0.0). Nothing is updated until a model and version are picked and confirmed.');
  st.outdated = new OutdatedFlow({ loadInfo: loadOutdatedInfo, flash: outdatedFlasher, onChange: () => render() });
  st.scan = { apps: [], freeStart: 0 };
  st.files = null;
  status(T('connect.ok', { name: dev?.productName || 'NumWorks', model: modelLabel(i.model) }), 'ok');
}

async function rescan() {
  const i = st.info;
  st.scan = await scanApps(st.dfu, i);
  const raw = await st.dfu.read(i.storageAddress, i.storageSize);
  st.files = parseStorage(raw);
  log(`${st.scan.apps.length} app(s) installed: ${st.scan.apps.map((a) => a.name).join(', ') || 'none'}`);
}

navigator.usb?.addEventListener('disconnect', (e) => {
  if (e.device === st.dev) {
    st.dev = st.dfu = st.info = st.scan = st.outdated = null;
    status(T('connect.unplugged'));
    log('Calculator disconnected');
    render();
  }
});

// how a model is named on the page (the Portugal prototype has a long name)
const modelLabel = (m) => (!m ? t('model.outdated') : m.startsWith('N0120_PORTUGAL') ? t('model.portugal') : m);

// ------------------------------------------------------------------ backups and restore
// (a limited calculator, lib/gate.js: these say why they can't, nothing read or written)
$('#backup-apps').addEventListener('click', () => job('backup', async () => {
  if (st.info.limited) return;  // (outdated firmware: no app area; its sections aren't shown)
  const i = st.info, end = Math.min(st.scan.freeStart + SECTOR, i.nwagraOk ? i.nwagraEnd : i.appsEnd);
  log(`Reading ${end - i.appsStart} bytes of apps…`);
  const data = await st.dfu.read(i.appsStart, end - i.appsStart, (p) => progress(p, 'progress.readingApps'));
  download(data, `numworks-apps-${hex(i.appsStart)}-${stamp()}.bin`);
  progress(null);
  log('Saved the app area backup');
}));

$('#backup-files').addEventListener('click', () => job('backup', async () => {
  if (st.info.limited) return;
  const raw = await st.dfu.read(st.info.storageAddress, st.info.storageSize);
  download(raw, `numworks-files-${stamp()}.bin`);
  log('Saved the files backup (' + (parseStorage(raw)?.files.length || 0) + ' files)');
}));

$('#restore').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  if (st.info?.limited) return;
  const data = new Uint8Array(await f.arrayBuffer());
  const i = st.info;
  const m = /0x([0-9a-f]{8})/i.exec(f.name);
  if (m && parseInt(m[1], 16) !== i.appsStart) { alert(t('restore.otherArea', { theirs: '0x' + m[1], ours: hex(i.appsStart) })); return; }
  const allFF = data.subarray(0, 32).every((b) => b === 0xff);
  if (!parseAppHeader(data.subarray(0, 32), i.appsStart) && !allFF) { alert(t('restore.notBackup')); return; }
  const end = i.nwagraOk ? i.nwagraEnd : i.appsEnd;
  if (data.length % SECTOR || i.appsStart + data.length > end) { alert(t('restore.noFit')); return; }
  if (!await confirmDialog(T('restore.confirm', { file: f.name, size: data.length }))) return;
  await job('restore', async () => {
    await st.dfu.write(i.appsStart, data, (p) => progress(p, 'progress.writing'));
    log('Restored the app area from ' + f.name);
    await finish();
  });
});

// ------------------------------------------------------------------ the apps to install
$('#pick').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

async function addFiles(list, extra = {}, { top = false } = {}) {
  for (const f of list) {
    if (!/\.nwa$/i.test(f.name)) { log(f.name + ': not a .nwa file, skipped'); continue; }
    const item = { file: f.name, name: f.name.replace(/\.nwa$/i, ''), nwa: new Uint8Array(await f.arrayBuffer()), size: null, ...extra };
    if (top) st.queue.unshift(item); else st.queue.push(item);
    render();
    inspect(item);
  }
}

// its name and size, from a trial link (for this calculator once connected, else for a typical one)
async function inspect(item) {
  try {
    await loadTools();
    const i = st.info?.limited ? null : st.info;
    const mem = i ? { flashStart: i.appsStart, flashLength: 0x800000, ramStart: i.appsRamStart, ramLength: i.appsRamEnd - i.appsRamStart, trampoline: i.trampoline }
      : { flashStart: 0x90200000, flashLength: 0x600000, ramStart: 0x20000000, ramLength: 0x40000, trampoline: 0x90010030 };
    const r = await inspectNwa(item.nwa, mem, item.data);
    Object.assign(item, { size: r.size, needsData: r.needsData, name: r.name || item.name, error: null });
    log(`${item.file}: "${item.name}", ${item.size ? sectors(item.size) + ' bytes installed' : 'needs an external data file'}`);
  } catch (e) {
    item.error = e;  // (drawn with errText, first line only)
    log(item.file + ': ' + e.message);
  }
  render();
}

// ------------------------------------------------------------------ options and the space bar
['#keep', '#nwagra', '#restart'].forEach((s) => $(s).addEventListener('change', render));

function layout() {
  const i = st.info, s = st.scan;
  const keep = $('#keep').checked, nwagra = $('#nwagra').checked && i.nwagraOk;
  const end = nwagra ? i.nwagraEnd : i.appsEnd;
  const kept = keep ? s.freeStart - i.appsStart : 0;
  const ready = st.queue.length > 0 && st.queue.every((q) => q.size && !q.error);
  const adding = st.queue.reduce((n, q) => n + (q.size ? sectors(q.size) : 0), 0);
  // the calculator only lists apps that start in its app area: with Nwagra only the last one may run on past it
  const last = st.queue.length ? sectors(st.queue[st.queue.length - 1].size || 0) : 0;
  const lastStart = i.appsStart + kept + adding - last;
  return { end, total: end - i.appsStart, std: i.appsEnd - i.appsStart, kept, adding, ready, nwagra,
    fits: i.appsStart + kept + adding <= end, startsOk: !st.queue.length || lastStart < i.appsEnd };
}

function render() {
  const on = !!st.info;
  const view = limitedView({ connected: on, limited: st.info?.limited });
  const full = view.normal;
  $('#s-apps').hidden = $('#s-new').hidden = $('#s-fw').hidden = !full;
  $('#info').hidden = !on;
  $('#connect').textContent = t(on ? 'connect.again' : 'connect.button');
  for (const b of document.querySelectorAll('#s-apps button, #s-new button:not(.np button), #s-fw button, #connect')) b.disabled = st.busy || (b.id !== 'connect' && !full) || (b.id === 'connect' && NO_USB);
  drawSimBadge();
  drawOutdated();
  if (!on) return;
  const i = st.info;
  const info = $('#info');
  info.textContent = '';
  const add = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); info.append(d); };
  add(t('info.model'), modelLabel(i.model));
  if (!full) return;
  renderFirmware();
  add(t('info.software'), t('info.softwareVal', { version: i.version, patch: i.patch, slot: i.slot }));
  add(t('info.area'), t('info.areaVal', { start: hex(i.appsStart), end: hex(i.appsEnd), size: i.appsEnd - i.appsStart }));
  add(t('info.nwagra'), i.nwagraOk ? t('info.areaVal', { start: hex(i.appsStart), end: hex(i.nwagraEnd), size: i.nwagraEnd - i.appsStart }) : t('info.nwagraNo'));

  const ul = $('#installed');
  ul.textContent = '';
  if (!st.scan.apps.length) ul.append(el('li', 'empty', t('apps.none')));
  for (const a of st.scan.apps) {
    const li = el('li');
    li.append(el('span', 'badge', a.name.slice(0, 1).toUpperCase()), el('span', 'name', a.name), el('span', 'meta', t('apps.at', { size: a.sectors * SECTOR, address: hex(a.address) })));
    if (a.address + a.size > i.appsEnd) li.append(el('span', 'warn', t('apps.pastArea')));
    ul.append(li);
  }
  const fileNames = st.files ? st.files.files.map((f) => f.name) : [];
  $('#files').textContent = st.files ? t('apps.files', { names: fileNames.length ? fileNames : t('apps.files.none') }) : '';

  const nw = $('#nwagra');
  nw.disabled = st.busy || !i.nwagraOk;
  if (!i.nwagraOk) nw.checked = false;
  $('#nwagra-opt').classList.toggle('disabled', !i.nwagraOk);
  $('#nwagra-note').textContent = !i.nwagraOk ? t('opt.nwagra.no')
    : t(i.slotB ? 'opt.nwagra.yesB' : 'opt.nwagra.yes', { size: i.nwagraEnd - i.appsStart, version: i.slotB });
  $('#keep').disabled = st.busy || !st.scan.apps.length;
  $('#keep').closest('.opt').classList.toggle('disabled', !st.scan.apps.length);

  drawQueue();

  const L = layout();
  const bar = $('#bar');
  bar.textContent = '';
  const pct = (n) => (100 * n / L.total) + '%';
  const k = el('div', 'kept'); k.style.width = pct(L.kept);
  const over = Math.max(0, L.kept + L.adding - L.total);
  const nw2 = el('div', over ? 'over' : 'new'); nw2.style.width = pct(Math.min(L.adding, L.total - L.kept));
  bar.append(k, nw2);
  if (L.nwagra) { const m = el('div', 'mark'); m.style.left = pct(L.std); m.title = t('space.stdEnd'); bar.append(m); }
  const lg = $('#legend');
  lg.textContent = '';
  const leg = (cls, txt) => { const s = el('span'); const ic = el('i'); ic.style.background = `var(--${cls})`; s.append(ic, txt); lg.append(s); };
  if (L.kept) leg('kept', t('space.kept', { size: L.kept }));
  leg(over ? 'bad' : 'new', t('space.new', { size: L.adding }));
  leg('free', over ? t('space.over', { size: over }) : t('space.free', { size: L.total - L.kept - L.adding }));

  const orNwagra = i.nwagraOk && !L.nwagra ? 'Nwagra' : '';
  $('#plan').textContent = !st.queue.length ? '' : !L.ready ? t('plan.waiting')
    : !L.fits ? t((L.kept ? 'plan.over.keep' : 'plan.over.remove') + orNwagra)
    : !L.startsOk ? t('plan.lastPast')
    : t('plan.writes', { size: L.adding + SECTOR, from: hex(i.appsStart + L.kept) });
  $('#install').disabled = st.busy || !L.ready || !L.fits || !L.startsOk;
  numplay.render();
}

function drawQueue() {
  const q = $('#queue');
  q.textContent = '';
  if (!st.queue.length) q.append(el('li', 'empty', t('queue.empty')));
  st.queue.forEach((item, n) => {
    const li = el('li');
    li.append(el('span', 'badge new', (item.name || '?').slice(0, 1).toUpperCase()), el('span', 'name', item.name));
    if (item.error) li.append(el('span', 'warn', errText(item.error).split('\n')[0]));
    else if (item.needsData) {
      const lab = el('label', 'link', t('queue.addData'));
      const inp = el('input'); inp.type = 'file'; inp.hidden = true;
      inp.addEventListener('change', async () => { item.data = new Uint8Array(await inp.files[0].arrayBuffer()); item.dataName = inp.files[0].name; inspect(item); });
      lab.append(inp);
      li.append(el('span', 'warn', t('queue.needsData')), lab);
    } else li.append(el('span', 'meta', !item.size ? t('queue.reading')
      : item.dataName ? t('queue.withData', { size: sectors(item.size), file: item.dataName }) : kb(sectors(item.size))));
    const up = el('button', 'x', '↑'); up.title = t('queue.up'); up.disabled = n === 0 || st.busy;
    up.addEventListener('click', () => { st.queue.splice(n - 1, 0, st.queue.splice(n, 1)[0]); render(); });
    const x = el('button', 'x', '✕'); x.title = t('queue.remove'); x.disabled = st.busy;
    x.addEventListener('click', () => { st.queue.splice(n, 1); render(); });
    li.append(up, x);
    q.append(li);
  });
}

// ------------------------------------------------------------------ installing
// text: T(...), so an open dialog follows a language change
function confirmDialog(text) {
  return new Promise((ok) => {
    const d = $('#confirm');
    d._text = text;
    $('#confirm-text').textContent = text();
    d.returnValue = '';
    d.addEventListener('close', () => { d._text = null; ok(d.returnValue === 'ok'); }, { once: true });
    d.showModal();
  });
}

$('#install').addEventListener('click', async () => {
  if (st.info?.limited) return;
  const i = st.info, L = layout();
  const keep = $('#keep').checked && st.scan.apps.length > 0;
  let plan;
  try {
    await loadTools();
    plan = await planInstall(i, st.scan, st.queue.map((q) => ({ name: q.name, nwa: q.nwa, data: q.data })), { keep, nwagra: L.nwagra });
  } catch (e) { log('Plan failed: ' + e.message); alert(errText(e)); return; }
  const names = plan.placed.map((p) => p.name);
  const count = st.scan.apps.length;
  const past = plan.start + plan.image.length > i.appsEnd;
  const text = () => (keep ? t('confirm.add', { names, count }) : t(count ? 'confirm.replace' : 'confirm.replaceEmpty', { names }))
    + ' ' + t(past ? 'confirm.writesNwagra' : 'confirm.writes', { size: plan.image.length, from: hex(plan.start) });
  if (!await confirmDialog(text)) return;
  await job('install', async () => {
    log(`Writing ${plan.image.length} bytes at ${hex(plan.start)}…`);
    await writeInstall(st.dfu, i, plan, (p) => progress(p, p < 0.3 ? 'progress.erasing' : 'progress.writing'));
    for (const p of plan.placed) log(`Installed ${p.name} at ${hex(p.address)} (${p.size} bytes)`);
    st.queue = [];
    await finish();
  });
});

async function finish() {
  progress(1, 'progress.done');
  if ($('#restart').checked) {
    await st.dfu.leave(st.info.appsStart).catch(() => {});
    log('Done. The calculator is restarting.');
    status(T('done.restarting'), 'ok');
    st.dev = st.dfu = st.info = st.scan = null;
  } else {
    await rescan();
    log('Done.');
  }
  setTimeout(() => progress(null), 2500);
}

// ------------------------------------------------------------------ calculator software (Epsilon updates)
// The local server (numworks.js) fetches NumWorks' official firmware, signed in with the account in numworks-account.json.
// Its .dfu holds both slots; as NumWorks' updater does, only the slot the calculator isn't running from can be
// written (the part inside the memory its DFU interface shows), and it restarts on it.
const slotOf = (addr) => (addr >= SLOT_B ? 'B' : 'A');

$('#fw-check').addEventListener('click', () => job('fwcheck', async () => {
  st.fw = null;
  if (!st.info) return;
  assertFirmwareAllowed(st.info.model);
  if (st.info.limited) return;  // (outdated firmware: only through its own update step)
  // (a guessed model could be the wrong one: an N0115 can look like an N0110, and its firmware is not the same)
  const s = MOCK ? { account: true } : await fetch('api/status').then((r) => r.json()).catch(() => null);
  if (!s) { fwSetup(T('fw.needServer')); return; }
  if (!s.account) { fwSetup(s.error ? () => errText(s.code ? s : { message: s.error }) : T('fw.needAccount')); return; }
  const r = await fetch(MOCK ? 'dev/mock/fw.json' : `api/firmware/${st.info.model}.json`);
  const j = await r.json();
  if (!r.ok) throw serverError(j, r.status);
  st.fw = j;
  st.fwChoice = firmwareChoices(j, { version: st.info.version, patch: st.info.patch });
  st.fwSetup = null;
  $('#fw-setup').hidden = true;
  log(`NumWorks offers Epsilon ${j.version} (${j.patch_level}) for the ${st.info.model}; kept here: ${(j.versions || []).map((v) => v.version).join(', ') || 'none'}`
    + (j.cache?.offline ? ' (NumWorks unreachable at the last check: ' + j.cache.error?.error + ')' : ''));
}));

function fwSetup(text) { st.fwSetup = text; drawFwSetup(); }
function drawFwSetup() {
  if (!st.fwSetup) return;
  const p = $('#fw-setup');
  p.hidden = false;
  p.textContent = st.fwSetup();
  $('#fw-box').hidden = true;
}

// the version picked in #fw-version: { version, patch, size, kind, available }
const fwPicked = () => st.fwChoice?.options.find((o) => o.version === st.fwChoice.selected) || null;

// #fw-version: the calculator's own version first when it's kept (recommended), then the other kept ones, newest first
function drawFwVersions() {
  const sel = $('#fw-version'), c = st.fwChoice;
  sel.textContent = '';
  for (const o of c.options) {
    const op = el('option', '', t('fw.opt.' + o.kind, { version: o.version, patch: o.patch || '?' }) + (o.channel === 'beta' ? ' ' + t('fw.opt.beta') : '')
      + (o.available ? '' : ' ' + t('fw.opt.notKept')));
    op.value = o.version;
    op.disabled = !o.available;
    sel.append(op);
  }
  sel.value = c.selected || '';
  sel.disabled = st.busy;
}
$('#fw-version').addEventListener('change', (e) => { if (st.fwChoice) { st.fwChoice.selected = e.target.value; render(); } });

function renderFirmware() {
  const i = st.info, all = st.fw;
  $('#fw-box').hidden = !all;
  if (!all) return;
  drawFwVersions();
  const p = fwPicked();
  const f = { version: p?.version, patch_level: p?.patch, size: p?.size, name: p?.version };
  const target = i.slot === 'A' ? 'B' : 'A';
  const same = f.version === i.version && (f.patch_level == null || f.patch_level === i.patch);
  const currentKept = st.fwChoice.options.some((o) => o.kind === 'current');
  $('#fw-recommend').hidden = false;
  $('#fw-recommend').textContent = t(currentKept ? 'fw.sameRecommended' : 'fw.currentNotKept', { version: i.version });
  const c = all.cache;
  $('#fw-cache').hidden = !c;
  if (c) $('#fw-cache').textContent = [c.offline && t('fw.cacheOffline', { msg: c.error ? errText(c.error) : '' }),
    c.lastChecked && t('fw.cacheChecked', { time: new Date(c.lastChecked).toLocaleString(getLang()) })].filter(Boolean).join(' ');
  $('#fw-now').textContent = t('info.softwareVal', { version: i.version, patch: i.patch, slot: i.slot });
  $('#fw-new').textContent = t('fw.offer', { version: all.version, patch: all.patch_level });
  const appsInB = st.scan.apps.some((a) => a.address + a.size > SLOT_B);
  $('#fw-note').textContent = [same && t('fw.same'), t('fw.goesIn', { slot: target }),
    t(target === 'A' ? 'fw.slotA' : 'fw.twice'), target === 'B' && appsInB && t('fw.breaksB')].filter(Boolean).join(' ');
  $('#fw-install').textContent = same ? t('fw.reinstall', { slot: target }) : t('fw.updateTo', { version: f.version });
  $('#fw-plan').textContent = t('fw.plan', { size: f.size || 0, slot: target });
  $('#fw-install').disabled = st.busy || !p?.available;
}

$('#fw-install').addEventListener('click', async () => {
  const i = st.info, p = fwPicked();
  if (!i || i.limited || !p?.available) return;
  try { assertFirmwareAllowed(i.model); } catch (e) { log(e.message); return; }
  const f = { version: p.version, patch_level: p.patch, name: p.version, channel: p.channel };
  const target = i.slot === 'A' ? 'B' : 'A';
  const keep = $('#fw-keep').checked;
  if (!await confirmDialog(() => t('fw.confirm', { version: f.version, patch: f.patch_level, slot: target }) + ' '
    + t(keep ? 'fw.confirm.keep' : 'fw.confirm.lose'))) return;
  await job('update', async () => {
    const bar = (label, vars) => (p) => progress(p, label, vars, $('#fw-progress'));
    // 1. the firmware, from NumWorks through the local server
    log(`Downloading Epsilon ${f.version} for the ${i.model}…`);
    bar('progress.downloading')(0);
    const r = await fetch(MOCK ? 'dev/mock/fw.dfu' : `api/firmware/${i.model}.dfu?version=${encodeURIComponent(f.name)}&channel=${encodeURIComponent(f.channel || 'stable')}`);
    if (!r.ok) throw serverError(await r.json().catch(() => ({})), r.status);
    const elements = writableElements(parseDfuFile(new Uint8Array(await r.arrayBuffer())), st.dfu);
    if (!elements.length) throw uiError('fw.nothing', {}, 'Nothing in that firmware is for the part of the calculator that can be written now');
    const slots = [...new Set(elements.map((e) => slotOf(e.address)))];
    if (slots.length !== 1 || slots[0] === i.slot) throw uiError('fw.wrongSlot', { slots: slots.join('+'), slot: i.slot }, `The firmware's writable part is for slot ${slots.join('+')}, but the calculator runs from slot ${i.slot}: stopping`);
    log(`Firmware: ${elements.map((e) => hex(e.address) + ' (' + e.data.length + ' bytes)').join(', ')} for slot ${slots[0]}`);
    // 2. the files, so the scripts can come back
    let scripts = [], skipped = [];
    if (keep) {
      const raw = await st.dfu.read(i.storageAddress, i.storageSize);
      download(raw, `numworks-files-${stamp()}.bin`);
      scripts = (parseStorage(raw)?.files || []).filter((x) => /\.py$/.test(x.name));
      // (a record holds at most 64 KB: anything bigger can't be put back, only kept in the backup)
      const tooBig = scripts.filter((x) => recordSize(x) > MAX_RECORD);
      if (tooBig.length) {
        scripts = scripts.filter((x) => !tooBig.includes(x));
        skipped = tooBig.map((x) => x.name);
        log(`Too big to put back (kept in the backup .bin only): ${skipped.join(', ')}`);
      }
      log(`Saved ${scripts.length} Python script(s) and a backup of all files`);
    }
    // 3. write, checking every byte
    let n = 0;
    for (const e of elements) {
      const pad = (4 - (e.data.length % 4)) % 4;
      const data = new Uint8Array(e.data.length + pad).fill(0xff);
      data.set(e.data);
      n++;
      await st.dfu.write(e.address, data, bar('progress.writingN', { n, total: elements.length }));
      const back = await st.dfu.read(e.address, data.length, bar('progress.checkingN', { n, total: elements.length }));
      for (let k = 0; k < data.length; k++) if (back[k] !== data[k]) throw uiError('fw.check', { address: hex(e.address + k) }, 'Check failed at ' + hex(e.address + k) + '. The calculator still runs its current software: try again.');
    }
    log(`Wrote and checked slot ${slots[0]}. Restarting the calculator…`);
    // 4. restart on it, and wait for it to come back
    const serial = st.dev?.serialNumber;
    await st.dfu.leave(elements[0].address).catch(() => {});
    if (MOCK) { progress(1, 'progress.doneMock', {}, $('#fw-progress')); return; }
    st.dev = st.dfu = st.info = st.scan = null;
    st.fw = null;
    render();
    status(T('fw.restarting'));
    let dev = null;
    for (let s = 0; s < 90 && !dev; s++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      dev = (await navigator.usb.getDevices()).find((d) => d.vendorId === 0x0483 && (!serial || d.serialNumber === serial));
    }
    if (!dev) { status(T('fw.updatedReconnect'), 'ok'); log('The calculator did not come back by itself: connect again'); return; }
    await new Promise((ok) => setTimeout(ok, 1500));
    await connect(dev);
    log(`Now on Epsilon ${st.info.version} (${st.info.patch}), slot ${st.info.slot}`);
    // 5. the scripts back, next to whatever files the new software has
    if (scripts.length) {
      const now = parseStorage(await st.dfu.read(st.info.storageAddress, st.info.storageSize));
      const have = new Set((now?.files || []).map((x) => x.name));
      const missing = scripts.filter((x) => !have.has(x.name));
      if (missing.length) {
        // (buildStorage refuses, rather than cuts, anything that doesn't fit; the backup .bin has everything)
        try {
          await st.dfu.program(st.info.storageAddress, buildStorage((now?.files || []).concat(missing), st.info.storageSize));
        } catch (e) {
          if (e.code !== 'storage.full' && e.code !== 'storage.tooBig') throw e;
          log('Could not put the scripts back: ' + e.message);
          status(T('fw.scriptsNoRoom', { count: missing.length }), 'warn');
          await rescan();
          return;
        }
        await rescan();
      }
      log(`Put back ${missing.length} Python script(s)`);
    }
    if (skipped.length) { status(T('fw.scriptsSkipped', { count: skipped.length, files: skipped }), 'warn'); return; }
    status(T('fw.updated', { version: st.info.version, slot: st.info.slot }), 'ok');
  });
});

// ------------------------------------------------------------------ half-supported calculators (lib/gate.js)
// The pop-up (a modal <dialog>, #notice) for a refused calculator. n: { kind: 'refusal', title: T(...), text: T(...), onClose }.
// Its OK, Esc or the close button all close it; Tab stays on its OK (the page behind is inert while it's open).
function showNotice(n) {
  const d = $('#notice');
  if (d.open) d.close();  // (the one before, closed as by its OK)
  st.notice = n;
  drawNotice();
  d.showModal();
  $('#notice-ok').focus();
}
function drawNotice() {
  if (!st.notice) return;
  $('#notice').dataset.kind = st.notice.kind;
  $('#notice-title').textContent = st.notice.title();
  $('#notice-text').textContent = st.notice.text();
}
$('#notice').addEventListener('close', () => {
  const n = st.notice;
  st.notice = null;
  n?.onClose?.();
});
$('#notice').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); $('#notice-ok').focus(); }  // (its only control)
});

function drawSimBadge() {
  if (!SIM) return;
  $('#sim-badge-sub').textContent = t('sim.badge.sub', { what: t('sim.what.' + sim.simulatedModel(SIM).toLowerCase()) });
}

// what this computer keeps for that model (/api/firmware/<model>.json). Simulating: the same when the server has any,
// else made-up versions, so the screens can be tried without a server or an account.
async function loadOutdatedInfo(model) {
  if (SIM) {
    const j = await fetch(`api/firmware/${model}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return j?.versions?.length ? j : { versions: sim.SIMULATED_VERSIONS[model] || [] };
  }
  const r = await fetch(`api/firmware/${model}.json`);
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && j.code === 'fw.noneForModel') return { versions: [] };
  if (!r.ok) throw serverError(j, r.status);
  return j;
}

// writes the confirmed firmware to an outdated N0110/N0115: every part of the .dfu its DFU interface lets be written,
// each checked byte by byte, then restarts it. Never in a simulation (pickFlasher gives the simulated one there).
async function flashOutdated(model, option) {
  if (SIM || st.dfu?.simulated) throw uiError('sim.noWrite', {}, 'Simulation: nothing is ever written');
  assertFirmwareAllowed(model);
  const bar = (label, vars) => (p) => progress(p, label, vars, $('#od-progress'));
  log(`Downloading Epsilon ${option.version} (${option.channel}) for the ${model}…`);
  bar('progress.downloading')(0);
  const r = await fetch(`api/firmware/${model}.dfu?version=${encodeURIComponent(option.version)}&channel=${encodeURIComponent(option.channel || 'stable')}`);
  if (!r.ok) throw serverError(await r.json().catch(() => ({})), r.status);
  const elements = writableElements(parseDfuFile(new Uint8Array(await r.arrayBuffer())), st.dfu);
  if (!elements.length) throw uiError('fw.nothing', {}, 'Nothing in that firmware is for the part of the calculator that can be written now');
  log(`Firmware: ${elements.map((e) => hex(e.address) + ' (' + e.data.length + ' bytes)').join(', ')}`);
  let n = 0;
  for (const e of elements) {
    const pad = (4 - (e.data.length % 4)) % 4;
    const data = new Uint8Array(e.data.length + pad).fill(0xff);
    data.set(e.data);
    n++;
    await st.dfu.write(e.address, data, bar('progress.writingN', { n, total: elements.length }));
    const back = await st.dfu.read(e.address, data.length, bar('progress.checkingN', { n, total: elements.length }));
    for (let k = 0; k < data.length; k++) if (back[k] !== data[k]) throw uiError('fw.check', { address: hex(e.address + k) }, 'Check failed at ' + hex(e.address + k) + '. The calculator still runs its current software: try again.');
  }
  log(`Wrote and checked Epsilon ${option.version}. Restarting the calculator…`);
  await st.dfu.leave(elements[0].address).catch(() => {});
  return { simulated: false, model, version: option.version };
}
const outdatedFlasher = pickFlasher({ simulate: SIM, real: flashOutdated,
  simulated: sim && ((model, option) => sim.simulatedFlash(model, option, (p) => progress(p, 'progress.simulating', {}, $('#od-progress')))) });

function drawOutdated() {
  const f = st.outdated;
  $('#s-outdated').hidden = !f || !limitedView({ connected: !!st.info, limited: st.info?.limited }).outdatedFlow;
  if (!f) return;
  const locked = st.busy || f.step === 'flashing' || f.step === 'done';
  for (const b of document.querySelectorAll('.od-pick')) {
    b.setAttribute('aria-pressed', String(b.dataset.model === f.model));
    b.disabled = locked;
  }
  const choosing = f.step === 'version';
  $('#od-version-step').hidden = !(choosing || f.step === 'flashing' || f.step === 'done');
  const sel = $('#od-version');
  sel.textContent = '';
  f.options.forEach((o, n) => {
    const op = el('option', '', t('od.opt', { version: o.version, patch: o.patch || '?' }) + (o.channel === 'beta' ? ' ' + t('fw.opt.beta') : '')
      + (n === 0 ? ' ' + t('od.opt.oldest') : ''));
    op.value = o.version;
    sel.append(op);
  });
  sel.value = f.selected || '';
  sel.disabled = locked || !choosing;
  const picked = f.options.find((o) => o.version === f.selected);
  $('#od-plan').textContent = picked ? t('od.plan', { size: picked.size || 0, model: f.model }) : '';
  const msg = f.step === 'model' ? t('od.pickFirst') : f.step === 'loading' ? t('od.loading')
    : f.step === 'none' ? t('od.none', { model: f.model }) : f.step === 'error' && f.error ? t('od.error', { msg: errText(f.error) }) : '';
  $('#od-msg').hidden = !msg;
  $('#od-msg').textContent = msg;
  $('#od-msg').className = f.step === 'none' || f.step === 'error' ? 'note warn' : 'note';
  const u = $('#od-update');
  u.textContent = picked ? t('fw.updateTo', { version: picked.version }) : t('fw.install');
  u.disabled = locked || !choosing || !picked;
  $('#od-cancel').disabled = locked;
}

for (const b of document.querySelectorAll('.od-pick')) b.addEventListener('click', () => {
  st.outdated?.chooseModel(b.dataset.model).catch((e) => log('Model: ' + e.message));
});
$('#od-version').addEventListener('change', (e) => st.outdated?.select(e.target.value));
// Cancel: no update; nothing written, the calculator let go, the page back to not connected
$('#od-cancel').addEventListener('click', async () => {
  if (!st.outdated?.cancel()) return;
  log('Update cancelled: nothing written.');
  await st.dfu?.close().catch(() => {});
  st.dev = st.dfu = st.info = st.scan = st.outdated = null;
  status(T('connect.hint'));
  render();
});
$('#od-update').addEventListener('click', async () => {
  const f = st.outdated;
  if (!f || f.step !== 'version') return;
  const version = f.selected, model = f.model;
  // nothing is written before this explicit confirm of the version shown
  if (!await confirmDialog(T('od.confirm', { version, model }))) return;
  await job('update', async () => {
    if (st.outdated !== f) return;
    await f.confirm(version);
    progress(1, 'progress.done', {}, $('#od-progress'));
    if (f.result?.simulated) {
      log(`Simulated: Epsilon ${version} for the ${model}; nothing written`);
      status(T('od.simDone', { version, model }), 'ok');
      return;
    }
    st.dev = st.dfu = st.info = st.scan = st.outdated = null;
    status(T('od.done', { version }), 'ok');
  });
});

// ------------------------------------------------------------------ the NumPlay builder (numplay-ui.js)
const numplay = initNumPlay({
  log,
  // the space a NumPlay can take: what the apps to install leave free (with the options as set), its own part aside
  free: () => {
    if (!st.info || st.info.limited) return null;
    const L = layout(), others = st.queue.reduce((n, q) => n + (q.size ? sectors(q.size) : 0), 0);
    return L.total - L.kept - others;
  },
  // put what it made on top of the apps to install; one made before stays (take it out if you don't want it)
  add: async (bytes, name) => {
    await addFiles([new File([bytes], name + '.nwa')], { numplay: true }, { top: true });
  },
});

// ------------------------------------------------------------------ switching language: redraw in place, state kept
// (applyDom has redone index.html's text by now; numplay-ui.js listens on its own)
window.addEventListener('langchange', () => {
  drawStatus();
  drawFwSetup();
  drawNotice();
  for (const box of [$('#progress'), $('#fw-progress'), $('#od-progress')]) drawProgress(box);
  const d = $('#confirm');
  if (d.open && d._text) $('#confirm-text').textContent = d._text();
  render();
});

// a calculator this page was allowed to use before: connect straight away
if (!MOCK) navigator.usb?.getDevices().then((ds) => {
  const d = ds.find((x) => x.vendorId === 0x0483);
  if (d) job('connect', () => connect(d));
});
render();

// let go of the calculator when this page closes, so another tab or program can use it
window.addEventListener('pagehide', () => { if (st.dfu) st.dfu.close(); });
