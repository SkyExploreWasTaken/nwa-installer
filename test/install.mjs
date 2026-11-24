// Node test of the installer's code against the plugged-in calculator.
//   node test/install.mjs [--compare app.nwa]        link app.nwa where the first installed app is and compare bytes
//   node test/install.mjs [--keep] [--write] a.nwa..  plan an install (and with --write, flash it and restart)
import { createRequire } from 'module';
import { WebUSB } from './usb.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Dfu } from '../lib/dfu.js';
import { readInfo, scanApps, hex } from '../lib/calc.js';
import { setTools, linkApp } from '../lib/link.js';
import { planInstall, writeInstall, mb } from '../lib/install.js';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const V = path.join(here, '..', 'vendor');
setTools({ ld: [require(path.join(V, 'ld.js')), fs.readFileSync(path.join(V, 'ld.wasm'))],
  oc: [require(path.join(V, 'objcopy.js')), fs.readFileSync(path.join(V, 'objcopy.wasm'))],
  eadk: new Uint8Array(fs.readFileSync(path.join(V, 'eadk.o'))) });

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); if (i >= 0) { argv.splice(i, 1); return true; } return false; };
const opt = (f) => { const i = argv.indexOf(f); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } };
const compare = opt('--compare'), keep = flag('--keep'), write = flag('--write'), nwagra = flag('--nwagra');

const webusb = new WebUSB({ allowAllDevices: true });
const dev = (await webusb.getDevices()).find((d) => d.vendorId === 0x0483);
const dfu = new Dfu(dev);
await dfu.open();
const info = await readInfo(dfu);
const scan = await scanApps(dfu, info);
console.log(info.model, 'Epsilon', info.version, 'apps', hex(info.appsStart), '-', hex(info.appsEnd));
for (const a of scan.apps) console.log('  ', hex(a.address), a.name, a.size);

if (compare) {
  const a = scan.apps[0];
  const bin = await linkApp(new Uint8Array(fs.readFileSync(compare)), { flashStart: a.address, flashLength: info.appsEnd - a.address,
    ramStart: info.appsRamStart, ramLength: info.appsRamEnd - info.appsRamStart, trampoline: info.trampoline });
  const on = await dfu.read(a.address, bin.length);
  let diff = 0, first = -1;
  for (let i = 0; i < bin.length; i++) if (bin[i] !== on[i]) { diff++; if (first < 0) first = i; }
  console.log('linked', bin.length, 'bytes; on calculator', a.size, '; differing bytes', diff, first >= 0 ? 'first at +' + first : '');
} else if (argv.length) {
  const apps = argv.map((f) => ({ name: path.basename(f), nwa: new Uint8Array(fs.readFileSync(f)) }));
  const plan = await planInstall(info, scan, apps, { keep, nwagra });
  for (const p of plan.placed) console.log('  +', hex(p.address), p.name, p.size);
  console.log('write', mb(plan.image.length), 'at', hex(plan.start), '; free after:', mb(plan.free));
  if (write) {
    const t = Date.now();
    await writeInstall(dfu, info, plan, (p) => process.stdout.write('\r' + (p * 100).toFixed(0) + '%  '));
    console.log('\nwritten and verified in', Date.now() - t, 'ms');
    const again = await scanApps(dfu, info);
    for (const a of again.apps) console.log('  now', hex(a.address), a.name, a.size);
    if (flag('--no-leave') === false) { await dfu.leave(info.appsStart); console.log('calculator restarting'); }
  }
}
await dfu.close().catch(() => {});
