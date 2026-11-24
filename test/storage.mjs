// node test/storage.mjs [out.bin]: list the calculator's files (and save the raw storage)
import { createRequire } from 'module';
import { WebUSB } from './usb.mjs';
import fs from 'fs';
import { Dfu } from '../lib/dfu.js';
import { readInfo } from '../lib/calc.js';
import { parseStorage } from '../lib/storage.js';
const require = createRequire(import.meta.url);
const dev = (await new WebUSB({ allowAllDevices: true }).getDevices()).find((d) => d.vendorId === 0x0483);
const dfu = new Dfu(dev); await dfu.open();
const info = await readInfo(dfu);
const raw = await dfu.read(info.storageAddress, info.storageSize);
const st = parseStorage(raw);
for (const f of st.files) console.log(f.name, f.content.length);
console.log('used', st.used, 'of', info.storageSize);
if (process.argv[2]) fs.writeFileSync(process.argv[2], raw);
await dfu.close();
