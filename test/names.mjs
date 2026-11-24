// checks Dfu.readInterfaceNames (what Chrome on Windows needs) against the names node-usb reports
import { createRequire } from 'module';
import { WebUSB } from './usb.mjs';
import { Dfu } from '../lib/dfu.js';
const require = createRequire(import.meta.url);
const dev = (await new WebUSB({ allowAllDevices: true }).getDevices()).find((d) => d.vendorId === 0x0483);
if (!dev) { console.log('no calculator (another program may have it open)'); process.exit(1); }
await dev.open();
const dfu = new Dfu(dev);
console.log(await dfu.readInterfaceNames());
console.log(dev.configuration.interfaces.flatMap((i) => i.alternates.map((a) => i.interfaceNumber + ':' + a.alternateSetting + ' ' + a.interfaceName)));
await dev.close();
