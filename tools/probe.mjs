// What's on the plugged-in calculator: its memories, software and apps. Only reads.
//   node tools/probe.mjs [--dump apps.bin]     (--dump also saves the whole app area)
import fs from 'fs';
import { openCalculator, percent } from './usb.mjs';
import { scanApps, hex, FLASH_END } from '../public/lib/calc.js';

const { dev, dfu, info } = await openCalculator();
const hexify = (k, v) => (typeof v === 'number' && v > 0xffff ? hex(v) : v);
console.log(dev.productName, dev.serialNumber);
console.log('memories', JSON.stringify(dfu.layouts, hexify, 1));
console.log('info', JSON.stringify(info, hexify, 1));
const scan = await scanApps(dfu, info);
for (const a of scan.apps) console.log('app', hex(a.address), a.name, a.size + ' bytes');
console.log('free from', hex(scan.freeStart));

const i = process.argv.indexOf('--dump');
if (i > 0) {
  const data = await dfu.read(info.appsStart, FLASH_END - info.appsStart, percent);
  fs.writeFileSync(process.argv[i + 1], data);
  console.log('\nsaved', data.length, 'bytes to', process.argv[i + 1]);
}
await dfu.close();
