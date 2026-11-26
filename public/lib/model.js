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

export function detectModel({ usbVersion = null, productName = '', serialNumber = '', layouts = [] } = {}) {
  const bcd = Array.isArray(usbVersion) && usbVersion.length === 3 ? usbVersion.join('.') : null;
  const trusted = PRODUCTS.test(productName);
  let model = trusted && bcd ? BY_BCD[bcd] || null : null;
  const internal = size(layouts, 0x08000000, 0x080fffff), external = size(layouts, 0x90000000, 0x9fffffff);
  const n0120Ram = size(layouts, 0x24000000, 0x24ffffff) > 0;
  // Chrome for Android reports some N0120s as 1.1.4 (desktop: 1.2.0). A 1.1.x version not in the list, from a trusted
  // name, is taken for an N0120 only on a clear match of its memories: RAM at 0x24000000 and external flash, no
  // internal flash area. (N0110/N0115 can't be told apart by their memories: they stay unknown.)
  if (!model && trusted && bcd && bcd.startsWith('1.1.') && !Object.hasOwn(BY_BCD, bcd) && n0120Ram && external && !internal) model = 'N0120';
  if (model === 'N0120' && serialNumber === PORTUGAL_PROTOTYPE_SERIAL) model = 'N0120_PORTUGAL_PROTOTYPE_20210930';
  if (model) return { model };
  if (internal >= 0x100000 && !external) return { refuse: 'calc.n0100' };
  if (trusted && bcd === '1.0.0' && external && !n0120Ram) return { limited: 'outdated' };
  if (!trusted || bcd === '1.0.0' || !bcd) return { refuse: 'calc.updateFirst' };
  return { refuse: 'calc.unknownModel', bcd };
}

// the version numbers WebUSB gives for bcdDevice, or null
export const usbVersionOf = (dev) => (dev && Number.isInteger(dev.deviceVersionMajor)
  ? [dev.deviceVersionMajor, dev.deviceVersionMinor, dev.deviceVersionSubminor] : null);
