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
