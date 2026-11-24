// A pretend NumWorks firmware for ?mock: a DfuSe file with a slot A and a slot B image (random bytes)
import fs from 'fs';
const el = (address, size) => { const d = new Uint8Array(size); for (let i = 0; i < size; i++) d[i] = (i * 31 + address) & 0xff; return { address, d }; };
const els = [el(0x90000000, 0x30000), el(0x90400000, 0x30000)];
const body = [];
for (const e of els) { const h = Buffer.alloc(8); h.writeUInt32LE(e.address, 0); h.writeUInt32LE(e.d.length, 4); body.push(h, Buffer.from(e.d)); }
const elems = Buffer.concat(body);
const tp = Buffer.alloc(274); tp.write('Target', 0); tp.writeUInt32LE(elems.length, 266); tp.writeUInt32LE(els.length, 270);
const pre = Buffer.alloc(11); pre.write('DfuSe', 0); pre[5] = 1; pre[10] = 1;
const file = Buffer.concat([pre, tp, elems, Buffer.alloc(16)]);
pre.writeUInt32LE(file.length, 6);
fs.mkdirSync('test/mock', { recursive: true });
fs.writeFileSync('test/mock/fw.dfu', Buffer.concat([pre, tp, elems, Buffer.alloc(16)]));
fs.writeFileSync('test/mock/fw.json', JSON.stringify({ name: 'mock', version: '26.5.0', patch_level: 'mock123', size: 0x60000 }));
console.log('wrote test/mock/fw.dfu', file.length);
