// SPDX-License-Identifier: GPL-3.0-or-later
// The calculator's files (its "storage": Python scripts, settings, app saves), in RAM: a magic, then records of
// [u16 total size][name \0][content], ending with a 0 size. Names are UTF-8 both ways (café.py stays café.py).
import { InstallerError } from './errors.js';
const MAGIC = [0xba, 0xdd, 0x0b, 0xee];
export const MAX_RECORD = 0xffff;  // (a record's size is a u16: name, \0, content and the size itself)
const enc = new TextEncoder(), dec = new TextDecoder('utf-8');

export function parseStorage(b) {
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) return null;
  const files = [];
  let o = 4;
  while (o + 2 <= b.length) {
    const size = b[o] | (b[o + 1] << 8);
    if (size === 0 || o + size > b.length) break;
    let n = o + 2;
    while (n < o + size && b[n]) n++;
    files.push({ name: dec.decode(b.subarray(o + 2, n)), content: b.slice(n + 1, o + size) });
    o += size;
  }
  return { files, used: o + 2 };
}

// the bytes a file takes in the storage
export const recordSize = (f) => 2 + enc.encode(f.name).length + 1 + f.content.length;

// a storage image of `size` bytes holding these files (as parseStorage gives them). A file too big for one record
// (over 64 KB) or files that don't all fit are refused, never cut short.
export function buildStorage(files, size) {
  const b = new Uint8Array(size);
  b.set(MAGIC, 0);
  let o = 4;
  for (const f of files) {
    const name = enc.encode(f.name);
    const n = 2 + name.length + 1 + f.content.length;
    if (n > MAX_RECORD) throw new InstallerError('storage.tooBig', { file: f.name, size: n, max: MAX_RECORD }, `${f.name} is too big for the calculator storage (${n} bytes, at most ${MAX_RECORD})`);
    if (o + n + 2 > size) throw new InstallerError('storage.full', {}, 'The files do not fit in the calculator storage');
    b[o] = n & 0xff; b[o + 1] = n >> 8;
    b.set(name, o + 2);
    b.set(f.content, o + 2 + name.length + 1);
    o += n;
  }
  return b;  // (the rest stays 0: a record of size 0 ends the list)
}
