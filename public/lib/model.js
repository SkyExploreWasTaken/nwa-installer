// SPDX-License-Identifier: GPL-3.0-or-later
// Which NumWorks model is plugged in, from what it tells over USB, most authoritative signal first:
//  1. the USB device descriptor's bcdDevice (WebUSB: deviceVersionMajor.Minor.Subminor). Epsilon sets it per model:
//     0x0110 N0110, 0x0115 N0115, 0x0120 N0120 (numworks/epsilon, shared/ion/src/device/include/n01xx/config/usb.h,
//     `BCDDevice`, used as bcdDevice in shared/ion/src/device/shared/usb/calculator.h). NumWorks' own Upsilon.js
//     reads the same three numbers (UpsilonNumworks/Upsilon.js, Numworks.js, getModel()).
//  2. otherwise (Epsilon 15 and older, and Upsilon, answer 0x0100 on every model: numworks/epsilon tag 15.5.0,
//     ion/src/device/shared/usb/calculator.h, bcdDevice 0x0100), the memories its DFU interface shows, as Upsilon.js
//     does: RAM at 0x24000000 is an N0120; 1 MB of internal flash at 0x08000000 is an N0100; 8 MB of external flash at
//     0x90000000 is an N0110, or an N0115, which has the same memories. These are guesses, and say so.
// The N0120_PORTUGAL_PROTOTYPE_20210930 shows nothing of its own that's documented anywhere public: it's never
// detected, and an N0120 is what it shows as.
//   detectModel({ usbVersion: [major, minor, subminor] | null, productName, layouts }) -> { model, method, guessed }
//   method: 'usb' | 'memory' | 'unknown'

const BY_BCD = { '1.1.0': 'N0110', '1.1.5': 'N0115', '1.2.0': 'N0120' };

// the bytes of the memories that start in [lo, hi]
function size(layouts, lo, hi) {
  let n = 0;
  for (const l of layouts || []) for (const s of l.segments || []) if (s.start >= lo && s.start <= hi) n += s.end - s.start;
  return n;
}

export function detectModel({ usbVersion = null, productName = '', layouts = [] } = {}) {
  const bcd = Array.isArray(usbVersion) && usbVersion.length === 3 ? usbVersion.join('.') : null;
  // (Upsilon's own builds answer 0x0100 too: only a NumWorks build's number is trusted)
  if (bcd && BY_BCD[bcd] && !/upsilon/i.test(productName)) return { model: BY_BCD[bcd], method: 'usb', guessed: false };
  const ram24 = size(layouts, 0x24000000, 0x2407ffff) > 0;
  const internal = size(layouts, 0x08000000, 0x080fffff);
  const external = size(layouts, 0x90000000, 0x9fffffff);
  if (ram24) return { model: 'N0120', method: 'memory', guessed: true };
  if (internal >= 0x100000) return { model: 'N0100', method: 'memory', guessed: true };
  if (external > 0) return { model: 'N0110', method: 'memory', guessed: true };
  return { model: 'N0110', method: 'unknown', guessed: true };
}

// the version numbers WebUSB gives for bcdDevice, or null (no device, the mock)
export const usbVersionOf = (dev) => (dev && Number.isInteger(dev.deviceVersionMajor)
  ? [dev.deviceVersionMajor, dev.deviceVersionMinor, dev.deviceVersionSubminor] : null);
