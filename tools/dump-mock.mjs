// Saves what the page reads from the plugged-in calculator into public/dev/mock/, for the pretend calculator
// (http://localhost:8642/?mock) that tests the page without writing to a real one. Only reads.
//   node tools/dump-mock.mjs
import fs from 'fs';
import { openCalculator, repo } from './usb.mjs';

const { dev, dfu, info } = await openCalculator();
const dir = repo('public/dev/mock');
fs.mkdirSync(dir, { recursive: true });
const regions = [[info.ramStart, 16], [info.kernelHeader, 24], [info.userlandHeader, 48],
  [info.storageAddress, info.storageSize], [info.appsStart, info.appsEnd - info.appsStart]];
const meta = { product: dev.productName, layouts: dfu.layouts, regions: [] };
for (const [address, length] of regions) {
  const file = address.toString(16) + '.bin';
  fs.writeFileSync(dir + '/' + file, await dfu.read(address, length));
  meta.regions.push({ address, file });
}
fs.writeFileSync(dir + '/regions.json', JSON.stringify(meta, null, 1));
console.log('saved', meta.regions.length, 'regions to', dir);
await dfu.close();
