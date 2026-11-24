// node-usb's WebUSB, from this folder's node_modules (npm install) or a sibling project's
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let usb;
for (const p of ['usb', '../../numworks/node_modules/usb']) { try { usb = require(p); break; } catch (e) { /* next */ } }
if (!usb) throw new Error('node-usb not found: run npm install');
export const { WebUSB } = usb;
export async function calculator() {
  const dev = (await new WebUSB({ allowAllDevices: true }).getDevices()).find((d) => d.vendorId === 0x0483);
  if (!dev) throw new Error('No calculator found (plugged in and unlocked? another program or tab may have it open)');
  return dev;
}
