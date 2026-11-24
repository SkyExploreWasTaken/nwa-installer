// Saves the regions the page reads from the plugged-in calculator into test/mock/, so the page can run against a
// pretend calculator (index.html?mock). Reads only.
import { createRequire } from 'module';
import { WebUSB } from './usb.mjs';
import fs from 'fs';
import { Dfu } from '../lib/dfu.js';
import { readInfo } from '../lib/calc.js';
const require = createRequire(import.meta.url);
const dev = (await new WebUSB({ allowAllDevices: true }).getDevices()).find((d) => d.vendorId === 0x0483);
const dfu = new Dfu(dev); await dfu.open();
const info = await readInfo(dfu);
const regions = [[info.ramStart, 16], [info.kernelHeader, 24], [info.userlandHeader, 48],
  [info.storageAddress, info.storageSize], [info.appsStart, info.appsEnd - info.appsStart]];
const out = { layouts: dfu.layouts, product: dev.productName, regions: [] };
for (const [a, n] of regions) {
  const f = a.toString(16) + '.bin';
  fs.writeFileSync('test/mock/' + f, await dfu.read(a, n));
  out.regions.push({ address: a, file: f });
}
fs.writeFileSync('test/mock/regions.json', JSON.stringify(out, null, 1));
console.log('saved', out.regions.length, 'regions');
await dfu.close();
