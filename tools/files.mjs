// SPDX-License-Identifier: GPL-3.0-or-later
// The calculator's files. Only reads.
//   node tools/files.mjs [storage.bin]     (also saves the raw storage)
import fs from 'fs';
import { openCalculator } from './usb.mjs';
import { parseStorage } from '../public/lib/storage.js';

const { dfu, info } = await openCalculator();
const raw = await dfu.read(info.storageAddress, info.storageSize);
const storage = parseStorage(raw);
for (const f of storage.files) console.log(f.name.padEnd(24), f.content.length + ' bytes');
console.log(`${storage.used} of ${info.storageSize} bytes used`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], raw);
await dfu.close();
