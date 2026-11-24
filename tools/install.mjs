// SPDX-License-Identifier: GPL-3.0-or-later
// The installer from the command line.
//   node tools/install.mjs --compare app.nwa              link app.nwa where the first installed app is, compare bytes
//   node tools/install.mjs [--keep] [--nwagra] a.nwa ...  plan an install
//   ... add --write to flash it (and restart the calculator, unless --no-restart)
import fs from 'fs';
import path from 'path';
import { openCalculator, loadLinker, percent } from './usb.mjs';
import { scanApps, hex } from '../public/lib/calc.js';
import { linkApp } from '../public/lib/link.js';
import { planInstall, writeInstall, mb } from '../public/lib/install.js';

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const option = (f) => { const i = argv.indexOf(f); if (i < 0) return null; return argv.splice(i, 2)[1]; };
const compare = option('--compare');
const keep = flag('--keep'), nwagra = flag('--nwagra'), write = flag('--write'), restart = !flag('--no-restart');

loadLinker();
const { dfu, info } = await openCalculator();
const scan = await scanApps(dfu, info);
console.log(`${info.model}, Epsilon ${info.version}, slot ${info.slot}, apps ${hex(info.appsStart)}-${hex(info.appsEnd)}`);
for (const a of scan.apps) console.log('  ', hex(a.address), a.name, a.size + ' bytes');

if (compare) {
  const a = scan.apps[0];
  if (!a) throw new Error('No app on the calculator to compare with');
  const bin = await linkApp(new Uint8Array(fs.readFileSync(compare)), { flashStart: a.address, flashLength: info.appsEnd - a.address,
    ramStart: info.appsRamStart, ramLength: info.appsRamEnd - info.appsRamStart, trampoline: info.trampoline });
  const on = await dfu.read(a.address, bin.length);
  const diff = bin.reduce((n, b, i) => n + (b !== on[i]), 0);
  console.log(`linked ${bin.length} bytes, ${a.size} on the calculator: ${diff ? diff + ' bytes differ' : 'identical'}`);
} else if (argv.length) {
  const apps = argv.map((f) => ({ name: path.basename(f, '.nwa'), nwa: new Uint8Array(fs.readFileSync(f)) }));
  const plan = await planInstall(info, scan, apps, { keep, nwagra });
  for (const p of plan.placed) console.log('  +', hex(p.address), p.name, p.size + ' bytes');
  console.log(`writes ${mb(plan.image.length)} at ${hex(plan.start)}, ${mb(plan.free)} free after`);
  if (write) {
    await writeInstall(dfu, info, plan, percent);
    console.log('\nwritten and checked');
    if (restart) { await dfu.leave(info.appsStart); console.log('the calculator is restarting'); }
  }
}
await dfu.close().catch(() => {});
