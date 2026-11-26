// SPDX-License-Identifier: GPL-3.0-or-later
// Which NumWorks model is plugged in, from the USB device descriptor's bcdDevice (WebUSB: deviceVersionMajor.Minor.
// Subminor), the way NumWorks' own updater page does it (my.numworks.com/devices/upgrade, its script
// cdn.numworks.com/8221c22f.js): trusted only from a device named "NumWorks Calculator" or "NumWorks Scientific
// Calculator"; 0x0110 N0110, 0x0115 N0115, 0x0120 N0120 (the one Portugal prototype by its serial number), 0x0200
// N0200 (numworks/epsilon, shared/ion/src/device/include/n01xx/config/usb.h, `BCDDevice`).
// Anything else is only half supported, or not at all, and the page says why instead of guessing (gate.js):
//  - 0x0100 (Epsilon 15 and older, Upsilon, Omega) on the N0100's memories (1 MB internal flash, no external flash):
//    the N0100, refused: too old, no external flash so no app area for .nwa apps, and NumWorks stopped updating it.
//  - 0x0100 from a "NumWorks Calculator", with external flash and its RAM at 0x20000000 (not the N0120's): an N0110 or
//    N0115 on outdated firmware, { limited: 'outdated' }: the user says which (it's on the back) and may update it.
//  - 0x0100 otherwise (no descriptor, a fork's name, the N0120's RAM): update it on NumWorks' site first.
//  - another number: a model this page doesn't know.
//   detectModel({ usbVersion, productName, serialNumber, layouts })
//     -> { model } | { limited: 'outdated' } | { refuse: 'calc.n0100' | 'calc.updateFirst' | ... }

export const MODELS = ['N0110', 'N0115', 'N0120', 'N0120_PORTUGAL_PROTOTYPE_20210930', 'N0200'];
const BY_BCD = { '1.1.0': 'N0110', '1.1.5': 'N0115', '1.2.0': 'N0120', '2.0.0': 'N0200' };
const PRODUCTS = /^NumWorks (Scientific )?Calculator$/;
const PORTUGAL_PROTOTYPE_SERIAL = 'EAAbABVROTUxNDM4';

// the bytes of the memories that start in [lo, hi]
function size(layouts, lo, hi) {
  let n = 0;
  for (const l of layouts || []) for (const s of l.segments || []) if (s.start >= lo && s.start <= hi) n += s.end - s.start;
  return n;
}

export function detectModel({ usbVersion = null, productName = '', serialNumber = '', layouts = [], chosen = null, manual = false } = {}) {
  const bcd = Array.isArray(usbVersion) && usbVersion.length === 3 ? usbVersion.join('.') : null;
  const trusted = PRODUCTS.test(productName);
  // manual (Android: its USB version can't be trusted): never detected from the version, always picked by the user
  const manualPick = manual && trusted && bcd !== '1.0.0';
  let model = trusted && bcd && !manualPick ? BY_BCD[bcd] || null : null;
  const internal = size(layouts, 0x08000000, 0x080fffff), external = size(layouts, 0x90000000, 0x9fffffff);
  const n0120Ram = size(layouts, 0x24000000, 0x24ffffff) > 0;
  // Chrome for Android reports some N0120s as 1.1.4 (desktop: 1.2.0). A 1.1.x version not in the list, from a trusted
  // name, is taken for an N0120 only on a clear match of its memories: RAM at 0x24000000 and external flash, no
  // internal flash area. (N0110/N0115 can't be told apart by their memories: they stay unknown.)
  if (!model && !manualPick && trusted && bcd && bcd.startsWith('1.1.') && !Object.hasOwn(BY_BCD, bcd) && n0120Ram && external && !internal) model = 'N0120';
  if (model === 'N0120' && serialNumber === PORTUGAL_PROTOTYPE_SERIAL) model = 'N0120_PORTUGAL_PROTOTYPE_20210930';
  if (model) return { model };
  if (internal >= 0x100000 && !external) return { refuse: 'calc.n0100' };
  if (trusted && bcd === '1.0.0' && external && !n0120Ram) return { limited: 'outdated' };
  if (!trusted || bcd === '1.0.0' || (!bcd && !manualPick)) return { refuse: 'calc.updateFirst' };
  // a version this page doesn't know, from a trusted name: the user may say which model it is (the back label), but
  // only one the memories allow
  if (chosen != null) {
    if (!PICKABLE.includes(chosen)) return { refuse: 'calc.unknownModel', bcd };
    if (!pickableFrom(layouts).includes(chosen)) return { refuse: 'calc.pickMismatch', bcd, model: chosen };
    return { model: chosen === 'N0120' && serialNumber === PORTUGAL_PROTOTYPE_SERIAL ? 'N0120_PORTUGAL_PROTOTYPE_20210930' : chosen, picked: true };
  }
  return { refuse: 'calc.unknownModel', bcd: bcd || '?' };
}

// Chrome for Android: its USB version for these calculators can't be trusted (an N0120 shows as 1.1.4), so there the
// model is always picked by the user. nav: the browser's navigator (a parameter, for tests).
export const isAndroid = (nav) => !!nav && (nav.userAgentData?.platform === 'Android' || /Android/i.test(nav.userAgent || ''));

// does the software version the user read in Settings > About match the one the calculator says? "24.4" matches 24.4.0.
export function versionMatches(entered, actual) {
  const a = String(entered || '').trim().replace(/^v/i, '').split('.');
  const b = String(actual || '').trim().split('.');
  return a.length > 0 && a.every((x) => /^\d+$/.test(x)) && a.length <= b.length && a.every((x, i) => Number(x) === Number(b[i]));
}

// the models the user may pick when the USB version isn't known: only N0110, N0115, N0120, and only those whose
// memories (DFU layout) fit: external flash and no internal flash area for all of them; RAM at 0x24000000 for the
// N0120, at 0x20000000 for the N0110/N0115 (which their memories can't tell apart).
export const PICKABLE = ['N0110', 'N0115', 'N0120'];
function pickableFrom(layouts) {
  const internal = size(layouts, 0x08000000, 0x080fffff), external = size(layouts, 0x90000000, 0x9fffffff);
  if (!external || internal) return [];
  const n0120Ram = size(layouts, 0x24000000, 0x24ffffff) > 0;
  const ram = size(layouts, 0x20000000, 0x20ffffff) > 0;
  if (n0120Ram) return ['N0120'];
  return ram ? ['N0110', 'N0115'] : [];
}
// the models to offer for a calculator detectModel() didn't know -> [] when none (an untrusted name, no clear layout)
export function pickableModels({ productName = '', layouts = [] } = {}) {
  return PRODUCTS.test(productName) ? pickableFrom(layouts) : [];
}

// the version numbers WebUSB gives for bcdDevice, or null
export const usbVersionOf = (dev) => (dev && Number.isInteger(dev.deviceVersionMajor)
  ? [dev.deviceVersionMajor, dev.deviceVersionMinor, dev.deviceVersionSubminor] : null);
