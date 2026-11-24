// Reads (only reads) the plugged-in calculator: its memories, firmware info and installed apps.
//   node nwa-installer/test/probe.mjs [--dump out.bin]
import { createRequire } from 'module';
import { WebUSB } from './usb.mjs';
import fs from 'fs';
import { Dfu } from '../lib/dfu.js';
import { readInfo, scanApps } from '../lib/calc.js';
const require = createRequire(import.meta.url);

const webusb = new WebUSB({ allowAllDevices: true });
const devs = (await webusb.getDevices()).filter((d) => d.vendorId === 0x0483);
if (!devs.length) { console.log('no calculator'); process.exit(1); }
const dfu = new Dfu(devs[0]);
await dfu.open();
console.log(devs[0].productName, devs[0].serialNumber);
console.log(JSON.stringify(dfu.layouts, (k, v) => typeof v === 'number' && v > 0xffff ? '0x' + v.toString(16) : v, 1));
const info = await readInfo(dfu);
console.log(JSON.stringify(info, (k, v) => typeof v === 'number' && v > 0xffff ? '0x' + v.toString(16) : v, 1));
const t0 = Date.now();
const scan = await scanApps(dfu, info, { end: 0x90800000, progress: () => {} });
console.log('scan took', Date.now() - t0, 'ms');
for (const a of scan.apps) console.log('0x' + a.address.toString(16), a.name, a.size, 'api', a.apiLevel);
console.log('free from 0x' + scan.freeStart.toString(16));
const i = process.argv.indexOf('--dump');
if (i > 0) {
  const t1 = Date.now();
  const data = await dfu.read(info.appsStart, 0x90800000 - info.appsStart, (p) => process.stdout.write('\r' + (p * 100).toFixed(0) + '%'));
  fs.writeFileSync(process.argv[i + 1], data);
  console.log('\ndumped', data.length, 'in', Date.now() - t1, 'ms');
}
await dfu.close();
