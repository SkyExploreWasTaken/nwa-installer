// SPDX-License-Identifier: GPL-3.0-or-later
// Which NumWorks model is plugged in. Only a certain answer is used, never a guess:
//  - the USB device descriptor's bcdDevice (WebUSB: deviceVersionMajor.Minor.Subminor). Epsilon sets it per model:
//    0x0110 N0110, 0x0115 N0115, 0x0120 N0120 (numworks/epsilon, shared/ion/src/device/include/n01xx/config/usb.h,
//    `BCDDevice`, used as bcdDevice in shared/ion/src/device/shared/usb/calculator.h). NumWorks' own Upsilon.js reads
//    the same three numbers (UpsilonNumworks/Upsilon.js, Numworks.js, getModel()).
//  - otherwise (Epsilon 15 and older, and Upsilon, answer 0x0100 on every model: numworks/epsilon tag 15.5.0,
//    ion/src/device/shared/usb/calculator.h) the person reads the model number on the back of the calculator and picks
//    it; their choice is kept for that calculator (by its serial number). The memories its DFU interface shows only
//    rule out models it can't be (an N0100 has no external flash, only the N0120 has RAM at 0x24000000), never pick one.
// (The FCC ID shown in Settings > About, "2ALWP-N0xxx", is not used: on Epsilon 16+ it comes from the kernel, whose
// source isn't public, and there's no N0115 FCC ID, so it can't be relied on.)
//   detectModel({ usbVersion, productName, layouts }) -> { model: 'N0120' | null, certain, choices: [models possible] }

export const MODELS = ['N0100', 'N0110', 'N0115', 'N0120', 'N0120_PORTUGAL_PROTOTYPE_20210930'];
const BY_BCD = { '1.1.0': 'N0110', '1.1.5': 'N0115', '1.2.0': 'N0120' };

// the bytes of the memories that start in [lo, hi]
function size(layouts, lo, hi) {
  let n = 0;
  for (const l of layouts || []) for (const s of l.segments || []) if (s.start >= lo && s.start <= hi) n += s.end - s.start;
  return n;
}

// the models these memories don't rule out
export function possibleModels(layouts) {
  const ram24 = size(layouts, 0x24000000, 0x2407ffff) > 0;
  const external = size(layouts, 0x90000000, 0x9fffffff) > 0;
  const internal = size(layouts, 0x08000000, 0x080fffff);
  return MODELS.filter((m) => {
    const n0120 = m.startsWith('N0120');
    if (ram24 && !n0120) return false;                         // only the N0120 has its RAM there
    if (!ram24 && n0120 && (external || internal)) return false; // an N0120 always shows it
    if (external && m === 'N0100') return false;               // the N0100 has no external flash
    if (!external && internal && m !== 'N0100') return false;  // the others run from external flash
    return true;
  });
}

export function detectModel({ usbVersion = null, productName = '', layouts = [] } = {}) {
  const choices = possibleModels(layouts);
  const bcd = Array.isArray(usbVersion) && usbVersion.length === 3 ? usbVersion.join('.') : null;
  // (Upsilon's own builds don't follow NumWorks' numbering: only a NumWorks build's number is trusted)
  const model = bcd && !/upsilon/i.test(productName) ? BY_BCD[bcd] || null : null;
  return { model, certain: !!model, choices: model ? [model] : choices.length ? choices : [...MODELS] };
}

// the version numbers WebUSB gives for bcdDevice, or null (no device, the mock)
export const usbVersionOf = (dev) => (dev && Number.isInteger(dev.deviceVersionMajor)
  ? [dev.deviceVersionMajor, dev.deviceVersionMinor, dev.deviceVersionSubminor] : null);

// the model the person picked for this calculator before (by serial number), when it's still possible
const KEY = (serial) => 'nwa.model.' + serial;
export function savedModel(serial, choices, store = globalThis.localStorage) {
  if (!serial) return null;
  try { const m = store?.getItem(KEY(serial)); return m && choices.includes(m) ? m : null; } catch { return null; }
}
export function saveModel(serial, model, store = globalThis.localStorage) {
  if (!serial || !MODELS.includes(model)) return;
  try { store?.setItem(KEY(serial), model); } catch { /* no storage */ }
}

// ------------------------------------------------------------------ asking NumWorks (through the local server)
// The calculator's USB serial number is its 96-bit unique ID in base64 (numworks/epsilon,
// shared/ion/src/device/shared/drivers/serial_number.cpp and base64.cpp, the standard alphabet); my.numworks.com knows
// a calculator by that ID in upper-case hex. -> 'EgAaAAZRNTAxOTMy' -> '12001A000651353031393332', or null
export function serialHex(usbSerial) {
  if (typeof usbSerial !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(usbSerial)) return null;
  const bin = atob(usbSerial);
  if (bin.length !== 12) return null;
  return [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// a model name as NumWorks gives it, as the site names models (N0120, N0120_PORTUGAL_PROTOTYPE_20210930), or null
export function normalizeModel(name) {
  const m = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return /^N\d{4}(?:_[A-Z0-9]+)*$/.test(m) && m.length <= 64 ? m : null;
}

// /api/device/<serial>: { model, softwareVersion, patchLevel, cached } or null (not known, no account, offline with
// nothing kept, too slow): never throws, never waits more than `timeout`
export async function lookupDevice(serial, { fetch: f = globalThis.fetch, timeout = 5000 } = {}) {
  if (!serial || !f) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeout);
  try {
    const r = await Promise.race([f('api/device/' + serial, { signal: ctl?.signal }),
      new Promise((ok) => setTimeout(() => ok(null), timeout))]);
    if (!r || !r.ok) return null;
    const j = await r.json();
    return j && typeof j.model === 'string' ? j : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// readInfo's answer with NumWorks' (lookupDevice) on top: NumWorks' model wins when it names one; a disagreement with
// the USB descriptor or the memories is kept as a warning (for the log). Its software version stands in only when the
// calculator's own couldn't be read. -> { model, modelSource, warnings, version?, patch? }
export function mergeLookup(info, look) {
  const out = { model: info.model, modelSource: info.modelSource, warnings: [] };
  if (!info.version && look?.softwareVersion) Object.assign(out, { version: look.softwareVersion, patch: look.patchLevel || '' });
  const m = look && normalizeModel(look.model);
  if (!m) { if (look?.model) out.warnings.push(`NumWorks named a model this page can't read: ${look.model}`); return out; }
  if (info.modelSource === 'usb' && info.model !== m) out.warnings.push(`NumWorks says ${m}, the USB descriptor says ${info.model}: going with NumWorks`);
  else if (info.modelSource === 'user' && info.model !== m) out.warnings.push(`NumWorks says ${m}, you picked ${info.model} before: going with NumWorks`);
  if (info.modelPossible && MODELS.includes(m) && !info.modelPossible.includes(m)) out.warnings.push(`NumWorks says ${m}, which doesn't match the calculator's memories: going with NumWorks`);
  return Object.assign(out, { model: m, modelSource: look.cached ? 'numworks-cache' : 'numworks' });
}
