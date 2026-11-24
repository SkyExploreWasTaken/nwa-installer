import { createRequire } from 'module';
import { WebUSB } from './usb.mjs';
import { Dfu } from '../lib/dfu.js';
const require = createRequire(import.meta.url);
const webusb = new WebUSB({ allowAllDevices: true });
const dev = (await webusb.getDevices()).find((d) => d.vendorId === 0x0483);
const dfu = new Dfu(dev); await dfu.open();
for (const a of process.argv.slice(2)) { const [ad, n] = a.split(':'); const b = await dfu.read(parseInt(ad), parseInt(n || '64'));
  console.log(ad, Buffer.from(b).toString('hex').match(/.{1,64}/g).join('\n'), '\n', JSON.stringify(Buffer.from(b).toString('latin1').replace(/[^\x20-\x7e]/g,'.'))); }
await dfu.close();
