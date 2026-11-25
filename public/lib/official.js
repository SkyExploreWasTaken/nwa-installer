// SPDX-License-Identifier: GPL-3.0-or-later
// Whether the calculator runs NumWorks' official software, from what it shows over USB, read only. This page only
// works with official Epsilon (16 or later); calculators running a fork or unsigned software are refused. It assumes
// forks are honest (they say what they are); a deliberately disguised build isn't caught.
//  1. the DFU flash interface string of the running software. Epsilon 16+ has two forms per slot
//     (numworks/epsilon, shared/ion/src/device/include/n01xx/config/usb_userland.h): "Authenticated" (signed by
//     NumWorks, also with third-party .nwa apps installed) and "ThirdParty" (unsigned), which shows only the running
//     slot's own app area. Only those exact third-party strings are refused: any other string is let through (and
//     logged), so an older or newer Epsilon whose strings differ is never refused by mistake.
//  2. Upsilon's and Omega's marker blocks, which they put right after the userland header (UpsilonNumworks/Upsilon.js,
//     Numworks.js: Omega 0xDEADBEEF, Upsilon 0x69737055, both read big-endian).
//  3. Upsilon's bootloader names itself "Upsilon Bootloader" over USB.
// Slot B is never looked at: with Nwagra, it holds apps.
//   checkOfficial({ productName, flashStrings, afterUserland }) -> { official, reason, known }
//   reason: null | 'thirdParty' | 'upsilon' | 'omega' | 'upsilonBootloader'; known: whether the flash string was one
//   of the documented forms

export const THIRD_PARTY = ['@Flash/0x90030000/61*064Kg', '@Flash/0x90430000/61*064Kg'];
export const AUTHENTICATED = ['@Flash/0x90030000/61*064Kg,64*064Kg', '@Flash/0x90000000/08*004Kg,01*032Kg,63*064Kg/0x90430000/61*064Kg'];
const OMEGA = [0xde, 0xad, 0xbe, 0xef], UPSILON = [0x69, 0x73, 0x70, 0x55];

// whether bytes holds this 4-byte marker at a 4-byte-aligned offset
function hasMarker(bytes, marker) {
  for (let i = 0; i + 4 <= bytes.length; i += 4) if (marker.every((b, k) => bytes[i + k] === b)) return true;
  return false;
}

export function checkOfficial({ productName = '', flashStrings = [], afterUserland = new Uint8Array(0) } = {}) {
  const norm = (s) => s.replace(/\s+/g, '');
  const flash = flashStrings.map(norm).filter((s) => /^@Flash\//i.test(s) || /^@[^/]*flash/i.test(s));
  const known = flash.some((s) => THIRD_PARTY.includes(s) || AUTHENTICATED.includes(s));
  if (productName === 'Upsilon Bootloader') return { official: false, reason: 'upsilonBootloader', known };
  if (hasMarker(afterUserland, UPSILON)) return { official: false, reason: 'upsilon', known };
  if (hasMarker(afterUserland, OMEGA)) return { official: false, reason: 'omega', known };
  if (flash.some((s) => THIRD_PARTY.includes(s))) return { official: false, reason: 'thirdParty', known };
  return { official: true, reason: null, known };
}
