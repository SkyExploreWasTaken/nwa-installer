// The installer page: connect over WebUSB, show what's on the calculator, add .nwa files, install.
import { Dfu } from './lib/dfu.js';
import { readInfo, scanApps, parseAppHeader, hex, SECTOR, SLOT_B } from './lib/calc.js';
import { loadTools, inspectNwa } from './lib/link.js';
import { planInstall, writeInstall, mb } from './lib/install.js';
import { parseStorage, buildStorage } from './lib/storage.js';
import { parseDfuFile, writableElements } from './lib/dfufile.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const st = { dev: null, dfu: null, info: null, scan: null, queue: [], busy: false };

function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('#log').textContent += `[${t}] ${msg}\n`;
  $('#log').scrollTop = 1e9;
}
function status(msg, kind = '') { const s = $('#status'); s.textContent = msg; s.className = kind || 'muted'; }
function progress(p, label, box = $('#progress')) {
  box.hidden = p == null;
  if (p == null) return;
  box.querySelector('div').style.width = (p * 100).toFixed(1) + '%';
  box.querySelector('span').textContent = label || (p * 100).toFixed(0) + '%';
}
function download(bytes, name) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const kb = (n) => n < 1048576 ? Math.round(n / 1024) + ' KB' : mb(n);
const sectors = (n) => Math.ceil(n / SECTOR) * SECTOR;

// one USB job at a time
async function job(name, fn) {
  if (st.busy) return;
  st.busy = true;
  render();
  try { return await fn(); } catch (e) {
    log(name + ' failed: ' + (e.message || e));
    status(name + ' failed: ' + (e.message || e), 'warn');
    console.error(e);
  } finally { st.busy = false; render(); }
}

// ------------------------------------------------------------------ connecting
if (!('usb' in navigator)) {
  status('This browser has no WebUSB. Open this page in Chrome or Edge.', 'warn');
  $('#connect').disabled = true;
}

const MOCK = new URLSearchParams(location.search).has('mock');  // a pretend calculator, for testing (dev/mockdfu.js)

$('#connect').addEventListener('click', () => job('Connecting', async () => {
  if (MOCK) return connect(null);
  let dev;
  try { dev = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483 }] }); } catch (e) {
    if (e.name === 'NotFoundError') { status('No calculator picked. Plug it in, unlock it and try again.'); return; }
    throw e;
  }
  await connect(dev);
}));

async function connect(dev) {
  if (st.dfu) await st.dfu.close();
  st.dev = dev;
  st.dfu = MOCK ? await (await import('./dev/mockdfu.js')).mockDevice() : new Dfu(dev);
  try {
    await st.dfu.open();
    if (MOCK) dev = { productName: st.dfu.productName };
    status('Reading the calculator…');
    st.info = await readInfo(st.dfu);
  } catch (e) {
    // let go of the calculator, so a new try (or another program) can have it
    await st.dfu.close().catch(() => {});
    st.dev = st.dfu = st.info = st.scan = null;
    throw new Error(e.message + '. Unplug the calculator, plug it back in, unlock it, close other pages that use it (like my.numworks.com), then Connect again.');
  }
  log(`Connected: ${st.info.model}, Epsilon ${st.info.version} (${st.info.patch}), app area ${hex(st.info.appsStart)}–${hex(st.info.appsEnd)}`);
  await rescan();
  status(`Connected to ${dev.productName || 'NumWorks'} (${st.info.model})`, 'ok');
  loadTools().catch((e) => log('Linker: ' + e.message));
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
    st.dev = st.dfu = st.info = st.scan = null;
    status('Calculator disconnected.');
    log('Calculator disconnected');
    render();
  }
});

// ------------------------------------------------------------------ backups and restore
$('#backup-apps').addEventListener('click', () => job('Backup', async () => {
  const i = st.info, end = Math.min(st.scan.freeStart + SECTOR, i.nwagraOk ? i.nwagraEnd : i.appsEnd);
  log(`Reading ${kb(end - i.appsStart)} of apps…`);
  const data = await st.dfu.read(i.appsStart, end - i.appsStart, (p) => progress(p, 'Reading apps ' + (p * 100).toFixed(0) + '%'));
  download(data, `numworks-apps-${hex(i.appsStart)}-${stamp()}.bin`);
  progress(null);
  log('Saved the app area backup');
}));

$('#backup-files').addEventListener('click', () => job('Backup', async () => {
  const raw = await st.dfu.read(st.info.storageAddress, st.info.storageSize);
  download(raw, `numworks-files-${stamp()}.bin`);
  log('Saved the files backup (' + (parseStorage(raw)?.files.length || 0) + ' files)');
}));

$('#restore').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  const i = st.info;
  const m = /0x([0-9a-f]{8})/i.exec(f.name);
  if (m && parseInt(m[1], 16) !== i.appsStart) { alert(`That backup is of an app area at 0x${m[1]}, this calculator's starts at ${hex(i.appsStart)}.`); return; }
  const allFF = data.subarray(0, 32).every((b) => b === 0xff);
  if (!parseAppHeader(data.subarray(0, 32), i.appsStart) && !allFF) { alert('That file is not an app area backup.'); return; }
  const end = i.nwagraOk ? i.nwagraEnd : i.appsEnd;
  if (data.length % SECTOR || i.appsStart + data.length > end) { alert('That backup doesn\'t fit this calculator\'s app area.'); return; }
  if (!await confirmDialog(`Write ${f.name} (${kb(data.length)}) over the app area? The apps on the calculator now are replaced by the ones in the backup.`)) return;
  await job('Restore', async () => {
    await st.dfu.write(i.appsStart, data, (p) => progress(p, 'Writing ' + (p * 100).toFixed(0) + '%'));
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

async function addFiles(list) {
  for (const f of list) {
    if (!/\.nwa$/i.test(f.name)) { log(f.name + ': not a .nwa file, skipped'); continue; }
    const item = { file: f.name, name: f.name.replace(/\.nwa$/i, ''), nwa: new Uint8Array(await f.arrayBuffer()), size: null };
    st.queue.push(item);
    render();
    inspect(item);
  }
}

// its name and size, from a trial link (for this calculator once connected, else for a typical one)
async function inspect(item) {
  try {
    await loadTools();
    const i = st.info;
    const mem = i ? { flashStart: i.appsStart, flashLength: 0x800000, ramStart: i.appsRamStart, ramLength: i.appsRamEnd - i.appsRamStart, trampoline: i.trampoline }
      : { flashStart: 0x90200000, flashLength: 0x600000, ramStart: 0x20000000, ramLength: 0x40000, trampoline: 0x90010030 };
    const r = await inspectNwa(item.nwa, mem, item.data);
    Object.assign(item, { size: r.size, needsData: r.needsData, name: r.name || item.name, error: null });
    log(`${item.file}: "${item.name}", ${item.size ? kb(sectors(item.size)) + ' installed' : 'needs an external data file'}`);
  } catch (e) {
    item.error = String(e.message || e).split('\n')[0];
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
  $('#s-apps').hidden = $('#s-new').hidden = $('#s-fw').hidden = !on;
  $('#info').hidden = !on;
  $('#connect').textContent = on ? 'Reconnect' : 'Connect calculator';
  for (const b of document.querySelectorAll('#s-apps button, #s-new button, #s-fw button, #connect')) b.disabled = st.busy || (b.id !== 'connect' && !on);
  if (!on) return;
  const i = st.info;
  renderFirmware();

  const info = $('#info');
  info.textContent = '';
  const add = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); info.append(d); };
  add('Model', i.model);
  add('Software', `Epsilon ${i.version} (${i.patch}), slot ${i.slot}`);
  add('App area', `${hex(i.appsStart)} – ${hex(i.appsEnd)}, ${mb(i.appsEnd - i.appsStart)}`);
  add('With Nwagra', i.nwagraOk ? `${hex(i.appsStart)} – ${hex(i.nwagraEnd)}, ${mb(i.nwagraEnd - i.appsStart)}` : 'not possible (the calculator runs from its second slot)');

  const ul = $('#installed');
  ul.textContent = '';
  if (!st.scan.apps.length) ul.append(el('li', 'empty', 'No apps installed.'));
  for (const a of st.scan.apps) {
    const li = el('li');
    li.append(el('span', 'badge', a.name.slice(0, 1).toUpperCase()), el('span', 'name', a.name), el('span', 'meta', `${kb(a.sectors * SECTOR)} at ${hex(a.address)}`));
    if (a.address + a.size > i.appsEnd) li.append(el('span', 'warn', 'runs past the app area (Nwagra)'));
    ul.append(li);
  }
  $('#files').textContent = st.files ? `Files: ${st.files.files.map((f) => f.name).join(', ') || 'none'}. Installing doesn't write them, but the restart may lose files that aren't Python scripts: back them up first if they matter.` : '';

  const nw = $('#nwagra');
  nw.disabled = st.busy || !i.nwagraOk;
  if (!i.nwagraOk) nw.checked = false;
  $('#nwagra-opt').classList.toggle('disabled', !i.nwagraOk);
  $('#nwagra-note').textContent = !i.nwagraOk ? 'Not on this calculator: it runs from its second slot, which the extra space would overwrite.'
    : `Apps may run on past the app area, to the end of the flash: ${mb(i.nwagraEnd - i.appsStart)} in all. That space is the calculator's spare copy of its software (slot B${i.slotB ? ', Epsilon ' + i.slotB + ' now' : ''}), which gets overwritten; the calculator keeps running from slot A. Only the last app may go past the app area.`;
  $('#keep').disabled = st.busy || !st.scan.apps.length;
  $('#keep').closest('.opt').classList.toggle('disabled', !st.scan.apps.length);

  const q = $('#queue');
  q.textContent = '';
  if (!st.queue.length) q.append(el('li', 'empty', 'Nothing added yet.'));
  st.queue.forEach((item, n) => {
    const li = el('li');
    li.append(el('span', 'badge new', (item.name || '?').slice(0, 1).toUpperCase()), el('span', 'name', item.name));
    if (item.error) li.append(el('span', 'warn', item.error));
    else if (item.needsData) {
      const lab = el('label', 'link', 'add its data file…');
      const inp = el('input'); inp.type = 'file'; inp.hidden = true;
      inp.addEventListener('change', async () => { item.data = new Uint8Array(await inp.files[0].arrayBuffer()); item.dataName = inp.files[0].name; inspect(item); });
      lab.append(inp);
      li.append(el('span', 'warn', 'needs an external data file:'), lab);
    } else li.append(el('span', 'meta', item.size ? kb(sectors(item.size)) + (item.dataName ? ' with ' + item.dataName : '') : 'reading…'));
    const up = el('button', 'x', '↑'); up.title = 'Move up'; up.disabled = n === 0 || st.busy;
    up.addEventListener('click', () => { st.queue.splice(n - 1, 0, st.queue.splice(n, 1)[0]); render(); });
    const x = el('button', 'x', '✕'); x.title = 'Remove'; x.disabled = st.busy;
    x.addEventListener('click', () => { st.queue.splice(n, 1); render(); });
    li.append(up, x);
    q.append(li);
  });

  const L = layout();
  const bar = $('#bar');
  bar.textContent = '';
  const pct = (n) => (100 * n / L.total) + '%';
  const k = el('div', 'kept'); k.style.width = pct(L.kept);
  const over = Math.max(0, L.kept + L.adding - L.total);
  const nw2 = el('div', over ? 'over' : 'new'); nw2.style.width = pct(Math.min(L.adding, L.total - L.kept));
  bar.append(k, nw2);
  if (L.nwagra) { const m = el('div', 'mark'); m.style.left = pct(L.std); m.title = 'End of the standard app area'; bar.append(m); }
  const lg = $('#legend');
  lg.innerHTML = '';
  const leg = (cls, txt) => { const s = el('span'); const ic = el('i'); ic.style.background = `var(--${cls})`; s.append(ic, txt); lg.append(s); };
  if (L.kept) leg('kept', 'kept ' + kb(L.kept));
  leg(over ? 'bad' : 'new', 'new ' + kb(L.adding));
  leg('free', over ? mb(over) + ' too much' : 'free ' + kb(L.total - L.kept - L.adding));

  $('#plan').textContent = !st.queue.length ? '' : !L.ready ? 'Waiting on the apps above.'
    : !L.fits ? 'That\'s more than the space. ' + (L.kept ? 'Try without keeping the installed apps' : 'Take an app out') + (i.nwagraOk && !L.nwagra ? ', or turn on Nwagra.' : '.')
    : !L.startsOk ? 'The last app would start past the app area, where the calculator does not look. Move the biggest app last.'
    : `Writes ${kb(L.adding + SECTOR)} from ${hex(i.appsStart + L.kept)}.`;
  $('#install').disabled = st.busy || !L.ready || !L.fits || !L.startsOk;
}

// ------------------------------------------------------------------ installing
function confirmDialog(text) {
  return new Promise((ok) => {
    const d = $('#confirm');
    $('#confirm-text').textContent = text;
    d.returnValue = '';
    d.addEventListener('close', () => ok(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

$('#install').addEventListener('click', async () => {
  const i = st.info, L = layout();
  const keep = $('#keep').checked && st.scan.apps.length > 0;
  let plan;
  try {
    await loadTools();
    plan = await planInstall(i, st.scan, st.queue.map((q) => ({ name: q.name, nwa: q.nwa, data: q.data })), { keep, nwagra: L.nwagra });
  } catch (e) { log('Plan failed: ' + e.message); alert(e.message); return; }
  const names = plan.placed.map((p) => p.name).join(', ');
  const text = (keep ? `Add ${names} after the ${st.scan.apps.length} installed app(s).` : `Replace ${st.scan.apps.length ? 'the installed apps' : 'the (empty) app area'} with ${names}.`)
    + ` This writes ${kb(plan.image.length)} to the calculator's flash from ${hex(plan.start)}`
    + (plan.start + plan.image.length > i.appsEnd ? ', past the standard app area (Nwagra)' : '') + '.';
  if (!await confirmDialog(text)) return;
  await job('Install', async () => {
    log(`Writing ${kb(plan.image.length)} at ${hex(plan.start)}…`);
    await writeInstall(st.dfu, i, plan, (p) => progress(p, (p < 0.3 ? 'Erasing ' : 'Writing ') + (p * 100).toFixed(0) + '%'));
    for (const p of plan.placed) log(`Installed ${p.name} at ${hex(p.address)} (${kb(p.size)})`);
    st.queue = [];
    await finish();
  });
});

async function finish() {
  progress(1, 'Done');
  if ($('#restart').checked) {
    await st.dfu.leave(st.info.appsStart).catch(() => {});
    log('Done. The calculator is restarting.');
    status('Done. The calculator is restarting; connect again to see its apps.', 'ok');
    st.dev = st.dfu = st.info = st.scan = null;
  } else {
    await rescan();
    log('Done.');
  }
  setTimeout(() => progress(null), 2500);
}

// ------------------------------------------------------------------ calculator software (Epsilon updates)
// The local server (server.js) fetches NumWorks' official firmware with the session in numworks-cookie.txt.
// Its .dfu holds both slots; as NumWorks' updater does, only the slot the calculator isn't running from can be
// written (the part inside the memory its DFU interface shows), and it restarts on it.
const slotOf = (addr) => (addr >= SLOT_B ? 'B' : 'A');

$('#fw-check').addEventListener('click', () => job('Checking for updates', async () => {
  st.fw = null;
  const s = MOCK ? { cookie: true } : await fetch('api/status').then((r) => r.json()).catch(() => null);
  if (!s) { fwSetup('Updates need this page served by server.js (npm start), not another web server.'); return; }
  if (!s.cookie) { fwSetup('Updates need your NumWorks session: see "Calculator software updates" in the README to make numworks-cookie.txt next to server.js, then check again.'); return; }
  const r = await fetch(MOCK ? 'dev/mock/fw.json' : `api/firmware/${st.info.model}.json`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  st.fw = j;
  $('#fw-setup').hidden = true;
  log(`NumWorks offers Epsilon ${j.version} (${j.patch_level}) for the ${st.info.model}`);
}));

function fwSetup(text) { const p = $('#fw-setup'); p.hidden = false; p.textContent = text; $('#fw-box').hidden = true; }

function renderFirmware() {
  const i = st.info, f = st.fw;
  $('#fw-box').hidden = !f;
  if (!f) return;
  const target = i.slot === 'A' ? 'B' : 'A';
  const same = f.version === i.version && f.patch_level === i.patch;
  $('#fw-now').textContent = `Epsilon ${i.version} (${i.patch}), slot ${i.slot}`;
  $('#fw-new').textContent = `Epsilon ${f.version} (${f.patch_level})`;
  const appsInB = st.scan.apps.some((a) => a.address + a.size > SLOT_B);
  $('#fw-note').textContent = (same ? 'You have this version already. ' : '')
    + `It goes in slot ${target}, the one the calculator is not running, and the calculator restarts on it.`
    + (target === 'A' ? ' Slot A is the one Nwagra needs.' : ' To end up on slot A (for Nwagra), update a second time after this one.')
    + (target === 'B' && appsInB ? ' Slot B holds the end of your Nwagra apps now: writing it breaks them, so install them again after.' : '');
  $('#fw-install').textContent = same ? `Reinstall in slot ${target}` : `Update to ${f.version}`;
  $('#fw-plan').textContent = `Writes about ${mb(f.size || 0)} to slot ${target}.`;
  $('#fw-install').disabled = st.busy;
}

$('#fw-install').addEventListener('click', async () => {
  const i = st.info, f = st.fw;
  const target = i.slot === 'A' ? 'B' : 'A';
  if (!await confirmDialog(`Write Epsilon ${f.version} (${f.patch_level}) into slot ${target} and restart the calculator on it? `
    + 'Do not unplug the calculator until it is done.' + ($('#fw-keep').checked ? ' Your Python scripts are saved first and put back after.' : ' Files on the calculator may be lost.'))) return;
  await job('Update', async () => {
    const bar = (label) => (p) => progress(p, label + ' ' + (p * 100).toFixed(0) + '%', $('#fw-progress'));
    // 1. the firmware, from NumWorks through the local server
    log(`Downloading Epsilon ${f.version} for the ${i.model}…`);
    bar('Downloading')(0);
    const r = await fetch(MOCK ? 'dev/mock/fw.dfu' : `api/firmware/${i.model}.dfu?version=${encodeURIComponent(f.name)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
    const elements = writableElements(parseDfuFile(new Uint8Array(await r.arrayBuffer())), st.dfu);
    if (!elements.length) throw new Error('Nothing in that firmware is for the part of the calculator that can be written now');
    const slots = [...new Set(elements.map((e) => slotOf(e.address)))];
    if (slots.length !== 1 || slots[0] === i.slot) throw new Error(`The firmware's writable part is for slot ${slots.join('+')}, but the calculator runs from slot ${i.slot}: stopping`);
    log(`Firmware: ${elements.map((e) => hex(e.address) + ' (' + kb(e.data.length) + ')').join(', ')} for slot ${slots[0]}`);
    // 2. the files, so the scripts can come back
    let scripts = [];
    if ($('#fw-keep').checked) {
      const raw = await st.dfu.read(i.storageAddress, i.storageSize);
      download(raw, `numworks-files-${stamp()}.bin`);
      scripts = (parseStorage(raw)?.files || []).filter((x) => /\.py$/.test(x.name));
      log(`Saved ${scripts.length} Python script(s) and a backup of all files`);
    }
    // 3. write, checking every byte
    let n = 0;
    for (const e of elements) {
      const pad = (4 - (e.data.length % 4)) % 4;
      const data = new Uint8Array(e.data.length + pad).fill(0xff);
      data.set(e.data);
      n++;
      await st.dfu.write(e.address, data, bar(`Writing ${n}/${elements.length}`));
      const back = await st.dfu.read(e.address, data.length, bar(`Checking ${n}/${elements.length}`));
      for (let k = 0; k < data.length; k++) if (back[k] !== data[k]) throw new Error('Check failed at ' + hex(e.address + k) + '. The calculator still runs its current software: try again.');
    }
    log(`Wrote and checked slot ${slots[0]}. Restarting the calculator…`);
    // 4. restart on it, and wait for it to come back
    const serial = st.dev?.serialNumber;
    await st.dfu.leave(elements[0].address).catch(() => {});
    if (MOCK) { progress(1, 'Done (pretend calculator: no restart)', $('#fw-progress')); return; }
    st.dev = st.dfu = st.info = st.scan = null;
    st.fw = null;
    render();
    status('Restarting… keep the calculator plugged in and unlocked.');
    let dev = null;
    for (let t = 0; t < 90 && !dev; t++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      dev = (await navigator.usb.getDevices()).find((d) => d.vendorId === 0x0483 && (!serial || d.serialNumber === serial));
    }
    if (!dev) { status('Updated. Connect again when the calculator is back.', 'ok'); log('The calculator did not come back by itself: connect again'); return; }
    await new Promise((ok) => setTimeout(ok, 1500));
    await connect(dev);
    log(`Now on Epsilon ${st.info.version} (${st.info.patch}), slot ${st.info.slot}`);
    // 5. the scripts back, next to whatever files the new software has
    if (scripts.length) {
      const now = parseStorage(await st.dfu.read(st.info.storageAddress, st.info.storageSize));
      const have = new Set((now?.files || []).map((x) => x.name));
      const missing = scripts.filter((x) => !have.has(x.name));
      if (missing.length) {
        await st.dfu.program(st.info.storageAddress, buildStorage((now?.files || []).concat(missing), st.info.storageSize));
        await rescan();
      }
      log(`Put back ${missing.length} Python script(s)`);
    }
    status(`Updated: Epsilon ${st.info.version}, slot ${st.info.slot}`, 'ok');
  });
});

// ------------------------------------------------------------------ from the NumPlay builder
// /numplay/ (NumPlay Studio, with numplay-bridge.js) keeps the last .nwa it made in IndexedDB: opened with ?numplay,
// this page puts it in the apps to install
function takeHandoff() {
  return new Promise((ok) => {
    const open = indexedDB.open('nwa-installer', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handoff');
    open.onerror = () => ok(null);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('handoff', 'readwrite'), store = tx.objectStore('handoff');
      const get = store.get('latest');
      get.onsuccess = () => { store.delete('latest'); ok(get.result || null); };
      tx.oncomplete = () => db.close();
    };
  });
}
if (new URLSearchParams(location.search).has('numplay')) {
  takeHandoff().then((h) => {
    if (!h) return;
    addFiles([new File([h.bytes], h.name)]);
    log(`${h.name} from the NumPlay builder is ready to install${st.info ? '' : ': connect the calculator'}`);
    history.replaceState(null, '', location.pathname);
  });
}

// a calculator this page was allowed to use before: connect straight away
if (!MOCK) navigator.usb?.getDevices().then((ds) => {
  const d = ds.find((x) => x.vendorId === 0x0483);
  if (d) job('Connecting', () => connect(d));
});
render();

// let go of the calculator when this page closes, so another tab or program can use it
window.addEventListener('pagehide', () => { if (st.dfu) st.dfu.close(); });
