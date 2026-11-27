// SPDX-License-Identifier: GPL-3.0-or-later
// ST's DfuSe file format (.dfu), as NumWorks' firmware comes: images of memory, each with its address.
// -> [{ address, data: Uint8Array, alt, target }]
import { InstallerError } from './errors.js';
export function parseDfuFile(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 11 + 16 || str(0, 5) !== 'DfuSe') throw new InstallerError('dfufile.notDfuSe', {}, 'Not a DfuSe file');
  const targets = b[10];
  const out = [];
  let o = 11;
  for (let t = 0; t < targets; t++) {
    if (str(o, 6) !== 'Target') throw new InstallerError('dfufile.badTarget', { target: t }, 'Corrupted DFU file (target ' + t + ')');
    const alt = b[o + 6];
    let name = '';
    if (v.getUint32(o + 7, true)) for (let i = o + 11; i < o + 266 && b[i]; i++) name += String.fromCharCode(b[i]);
    const count = v.getUint32(o + 270, true);
    o += 274;
    for (let e = 0; e < count; e++) {
      const address = v.getUint32(o, true), size = v.getUint32(o + 4, true);
      o += 8;
      if (o + size > b.length) throw new InstallerError('dfufile.overrun', {}, 'Corrupted DFU file (element runs past the end)');
      out.push({ address, data: b.subarray(o, o + size), alt, target: name });
      o += size;
    }
  }
  return out;
}

// the elements the calculator lets us write now (inside the memory its DFU interface shows): the slot it isn't
// running from, as NumWorks' updater does
export function writableElements(elements, dfu) {
  return elements.filter((e) => {
    const s = dfu.segmentFor(e.address);
    return s && s.writable;
  });
}


// The two copies of the software: slot A at 0x90000000, slot B from SLOT_B (public/lib/calc.js), to the end of the flash.
// Which slot an address is in, by its address.
const SLOT_B = 0x90400000, FLASH_END = 0x90800000;
export const slotOf = (addr) => (addr >= SLOT_B ? 'B' : 'A');
const slotEnd = (slot) => (slot === 'A' ? SLOT_B : FLASH_END);

// The elements of an update for the OTHER slot than the one the calculator runs from: only those whose address is in
// targetSlot (and whose end doesn't pass that slot), nothing of the running slot. Not "whatever the DFU interface lets
// be written": with the calculator on slot B it also exposes slot B's body past its header block, which is running code.
// Throws fw.nothing when the firmware has no element for the slot, fw.notWritable when one of its sectors isn't in
// memory the layout says can be erased and written (a part inside the running slot's protected header block, say).
export function elementsForSlot(elements, dfu, targetSlot) {
  const chosen = elements.filter((e) => slotOf(e.address) === targetSlot);
  if (!chosen.length) throw new InstallerError('fw.nothing', {}, 'Nothing in that firmware is for slot ' + targetSlot);
  for (const e of chosen) {
    const end = e.address + e.data.length;
    const bad = (a) => new InstallerError('fw.notWritable', { address: '0x' + a.toString(16), slot: targetSlot },
      'The firmware part at 0x' + a.toString(16) + ' (slot ' + targetSlot + ') is not in memory this calculator lets us write: stopping before anything is erased');
    if (end > slotEnd(targetSlot)) throw bad(slotEnd(targetSlot));
    for (let a = e.address; a < end;) {
      const s = dfu.segmentFor(a);
      if (!s || !s.erasable || !s.writable) throw bad(a);
      a = a - ((a - s.start) % s.sectorSize) + s.sectorSize;
    }
  }
  return chosen;
}
