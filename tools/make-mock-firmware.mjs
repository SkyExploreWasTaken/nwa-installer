// SPDX-License-Identifier: GPL-3.0-or-later
// A pretend NumWorks firmware for the pretend calculator (?mock): a DfuSe file with a slot A and a slot B image.
//   node tools/make-mock-firmware.mjs
import fs from 'fs';
import { repo } from './usb.mjs';

const image = (address, size) => ({ address, data: Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + address) & 0xff)) });
const images = [image(0x90000000, 0x30000), image(0x90400000, 0x30000)];

const elements = Buffer.concat(images.flatMap(({ address, data }) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(address, 0);
  head.writeUInt32LE(data.length, 4);
  return [head, data];
}));
const target = Buffer.alloc(274);               // "Target", alt 0, unnamed, size, element count
target.write('Target', 0);
target.writeUInt32LE(elements.length, 266);
target.writeUInt32LE(images.length, 270);
const prefix = Buffer.alloc(11);                // "DfuSe", version 1, file size, 1 target
prefix.write('DfuSe', 0);
prefix[5] = 1;
prefix[10] = 1;
const suffix = Buffer.alloc(16);
prefix.writeUInt32LE(prefix.length + target.length + elements.length + suffix.length, 6);

const dir = repo('public/dev/mock');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/fw.dfu', Buffer.concat([prefix, target, elements, suffix]));
fs.writeFileSync(dir + '/fw.json', JSON.stringify({ name: 'mock', version: '99.0.0', patch_level: 'mock', size: 0x60000 }));
console.log('wrote', dir + '/fw.dfu');
