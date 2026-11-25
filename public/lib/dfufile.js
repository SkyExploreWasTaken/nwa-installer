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
