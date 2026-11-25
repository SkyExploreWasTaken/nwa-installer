// SPDX-License-Identifier: GPL-3.0-or-later
// Which NumWorks model is plugged in, from the USB device descriptor's bcdDevice (WebUSB: deviceVersionMajor.Minor.
// Subminor), the way NumWorks' own updater page does it (my.numworks.com/devices/upgrade, its script
// cdn.numworks.com/8221c22f.js): trusted only from a device named "NumWorks Calculator" or "NumWorks Scientific
// Calculator"; 0x0110 N0110, 0x0115 N0115, 0x0120 N0120 (the one Portugal prototype by its serial number), 0x0200
// N0200 (numworks/epsilon, shared/ion/src/device/include/n01xx/config/usb.h, `BCDDevice`).
// Anything else isn't supported, and the page says why instead of guessing:
//  - 0x0100 (Epsilon 15 and older, Upsilon, Omega) on the N0100's memories (1 MB internal flash, no external flash):
//    the N0100, not supported.
//  - 0x0100 otherwise (an N0110 or N0115 on old or unofficial software): update it on NumWorks' site first.
//  - another number: a model this page doesn't know.
//   detectModel({ usbVersion, productName, serialNumber, layouts }) -> { model } or { refuse: 'calc.n0100' | ... }

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
  if (model === 'N0120' && serialNumber === PORTUGAL_PROTOTYPE_SERIAL) model = 'N0120_PORTUGAL_PROTOTYPE_20210930';
  if (model) return { model };
  const internal = size(layouts, 0x08000000, 0x080fffff), external = size(layouts, 0x90000000, 0x9fffffff);
  if (internal >= 0x100000 && !external) return { refuse: 'calc.n0100' };
  if (!trusted || bcd === '1.0.0' || !bcd) return { refuse: 'calc.updateFirst' };
  return { refuse: 'calc.unknownModel', bcd };
}

// the version numbers WebUSB gives for bcdDevice, or null
export const usbVersionOf = (dev) => (dev && Number.isInteger(dev.deviceVersionMajor)
  ? [dev.deviceVersionMajor, dev.deviceVersionMinor, dev.deviceVersionSubminor] : null);
