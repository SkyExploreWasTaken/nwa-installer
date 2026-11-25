// SPDX-License-Identifier: GPL-3.0-or-later
// Your own Game Boy, NES and Sega games for NumPlay's Retro-Go: each file read the way Retro-Go reads it in place,
// and the table of games (np_roms) it finds in its block of NumPlay. This follows NumPlay Studio's app.js and
// NumPlay's tools/romtable.py (https://github.com/Mason363/NumPlay, GPL-3.0). The games stay in the page: nothing
// is uploaded.
import { InstallerError } from './errors.js';

export const SYSTEMS = {
  1: { tag: 'GB', name: 'Game Boy' },
  2: { tag: 'GBC', name: 'Game Boy Color' },
  3: { tag: 'NES', name: 'NES' },
  4: { tag: 'SMS', name: 'Master System' },
  5: { tag: 'GG', name: 'Game Gear' },
  6: { tag: 'SG', name: 'SG-1000' },
  7: { tag: 'COL', name: 'ColecoVision' },
  8: { tag: 'GW', name: 'Game & Watch' },
  9: { tag: 'MD', name: 'Mega Drive' },
};
const EXT = { gb: 1, gbc: 2, nes: 3, sms: 4, gg: 5, sg: 6, col: 7, gw: 8, md: 9, gen: 9, bin: 9, smd: 9 };
// Mega Drive games need all of NumPlay's RAM: with one, Retro-Go goes on the calculator as an app of its own
export const MEGA_DRIVE = 9;
export const ROM_HEAD = 12, ROM_ENTRY = 52;

const align4 = (n) => (n + 3) & ~3;

// the file extensions Retro-Go takes for these systems, for a file picker's accept
export const extensions = (systems) => Object.keys(EXT).filter((x) => systems.includes(EXT[x])).map((x) => '.' + x);

// a game's file -> { sys, name, bytes }, or throws why it can't go in
export function romFrom(bytes, fileName, systems) {
  const sys = EXT[(fileName.split('.').pop() || '').toLowerCase()];
  if (!sys || !systems.includes(sys)) {
    const names = systems.map((s) => SYSTEMS[s].name).join(', ').replace(/, ([^,]*)$/, ' and $1');
    throw new InstallerError('roms.system', { systems: systems.map((s) => SYSTEMS[s].name) }, 'Retro-Go plays ' + names + ' games');
  }
  const out = sys === 8 ? lz4Unpack(bytes) : sys === MEGA_DRIVE ? megaDrive(bytes, /\.smd$/i.test(fileName)) : trim(bytes, sys);
  return { sys, name: shortName(fileName), bytes: out };
}

// what a game takes in NumPlay: its entry in the table and its bytes
export const romSize = (r) => ROM_ENTRY + align4(r.bytes.length);

// The table Retro-Go reads: "NPRM", version 1, the count, then 52 bytes per game (offset, size, system, 3 spare
// bytes, its name in 40), then the games
export function romTable(roms) {
  let at = align4(ROM_HEAD + ROM_ENTRY * roms.length);
  const offsets = roms.map((r) => { const o = at; at = align4(at + r.bytes.length); return o; });
  const d = new Uint8Array(at), v = new DataView(d.buffer), enc = new TextEncoder();
  v.setUint32(0, 0x4D52504E, true); v.setUint32(4, 1, true); v.setUint32(8, roms.length, true);
  roms.forEach((r, i) => {
    const e = ROM_HEAD + ROM_ENTRY * i;
    v.setUint32(e, offsets[i], true); v.setUint32(e + 4, r.bytes.length, true); d[e + 8] = r.sys;
    d.set(enc.encode(r.name).slice(0, 40), e + 12);
    d.set(r.bytes, offsets[i]);
  });
  return d;
}

// its file's name without the extension, at most 40 bytes of UTF-8, no letter cut
function shortName(file) {
  const enc = new TextEncoder();
  let n = '';
  for (const ch of file.replace(/\.[^.]*$/, '')) {
    if (enc.encode(n + ch).length > 40) break;
    n += ch;
  }
  return n;
}

// A ROM without the padding its file has to reach a power of two (16 KB banks at its end, all 0xFF or all 0x00):
// the emulators repeat the banks a game has for those it lacks, as a cartridge does
function trim(bytes, sys) {
  const B = 16384;
  if (![1, 2, 4, 5, 6].includes(sys) || bytes.length % B) return bytes;
  const keep = sys <= 2 ? 0x8000 : bytes.length <= 0x8000 ? bytes.length : 0xC000, pad = bytes[bytes.length - 1];
  if (pad !== 0x00 && pad !== 0xFF) return bytes;
  let n = bytes.length;
  while (n - B >= keep && bytes.subarray(n - B, n).every((v) => v === pad)) n -= B;
  return n < bytes.length ? bytes.slice(0, n) : bytes;
}

// A Game & Watch file packed in an LZ4 frame (as LCD-Game-Shrinker writes them), unpacked
function lz4Unpack(d) {
  if (d.length < 7 || d[0] !== 0x04 || d[1] !== 0x22 || d[2] !== 0x4d || d[3] !== 0x18) return d;
  const flg = d[4], u32 = (i) => (d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24) >>> 0;
  let i = 7 + (flg & 8 ? 8 : 0) + (flg & 1 ? 4 : 0), out = new Uint8Array(1 << 20), o = 0;
  const need = (n) => { if (o + n > out.length) { const b = new Uint8Array(Math.max(out.length * 2, o + n)); b.set(out); out = b; } };
  while (i + 4 <= d.length) {
    const h = u32(i); i += 4;
    if (!h) break;
    const n = h & 0x7fffffff, end = i + n;
    if (end > d.length) throw new InstallerError('roms.badLz4', {}, 'a broken LZ4 file');
    if (h & 0x80000000) { need(n); out.set(d.subarray(i, end), o); o += n; i = end + (flg & 0x10 ? 4 : 0); continue; }
    while (i < end) {
      const tok = d[i++];
      let lit = tok >> 4;
      if (lit === 15) for (let b = 255; b === 255 && i < end;) lit += (b = d[i++]);
      need(lit); out.set(d.subarray(i, i + lit), o); o += lit; i += lit;
      if (i >= end) break;
      const off = d[i] | d[i + 1] << 8;
      i += 2;
      let ml = (tok & 15) + 4;
      if ((tok & 15) === 15) for (let b = 255; b === 255 && i < end;) ml += (b = d[i++]);
      if (!off || off > o) throw new InstallerError('roms.badLz4', {}, 'a broken LZ4 file');
      need(ml);
      for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
    }
    i = end + (flg & 0x10 ? 4 : 0);
  }
  return out.slice(0, o);
}

// A Mega Drive game as Retro-Go reads it: plain (an .smd file's header dropped and its 16 KB blocks put back in
// order), its bytes swapped in pairs, a zero added to an odd size
function megaDrive(d, smd) {
  if ((smd || (d.length > 0x200 && d[1] === 3 && d[8] === 0xaa && d[9] === 0xbb)) && d.length % 0x4000 === 0x200) {
    const body = d.subarray(0x200), plain = new Uint8Array(body.length);
    for (let k = 0; k < body.length; k += 0x4000)
      for (let j = 0; j < 0x2000; j++) { plain[k + 2 * j] = body[k + 0x2000 + j]; plain[k + 2 * j + 1] = body[k + j]; }
    d = plain;
  }
  const out = new Uint8Array(d.length + (d.length & 1));
  for (let k = 0; k + 1 < out.length; k += 2) { out[k] = d[k + 1] || 0; out[k + 1] = d[k]; }
  return out;
}
