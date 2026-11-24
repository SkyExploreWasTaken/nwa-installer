// SPDX-License-Identifier: GPL-3.0-or-later
// The calculator's files (its "storage": Python scripts, settings, app saves), in RAM: a magic, then records of
// [u16 total size][name \0][content], ending with a 0 size.
const MAGIC = [0xba, 0xdd, 0x0b, 0xee];
export function parseStorage(b) {
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) return null;
  const files = [];
  let o = 4;
  while (o + 2 <= b.length) {
    const size = b[o] | (b[o + 1] << 8);
    if (size === 0 || o + size > b.length) break;
    let n = o + 2, name = '';
    while (n < o + size && b[n]) name += String.fromCharCode(b[n++]);
    files.push({ name, content: b.slice(n + 1, o + size) });
    o += size;
  }
  return { files, used: o + 2 };
}

// a storage image of `size` bytes holding these files (as parseStorage gives them)
export function buildStorage(files, size) {
  const b = new Uint8Array(size);
  b.set(MAGIC, 0);
  let o = 4;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const n = 2 + name.length + 1 + f.content.length;
    if (o + n + 2 > size) throw new Error('The files do not fit in the calculator storage');
    b[o] = n & 0xff; b[o + 1] = n >> 8;
    b.set(name, o + 2);
    b.set(f.content, o + 2 + name.length + 1);
    o += n;
  }
  return b;  // (the rest stays 0: a record of size 0 ends the list)
}
