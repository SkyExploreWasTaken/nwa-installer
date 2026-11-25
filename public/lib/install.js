// SPDX-License-Identifier: GPL-3.0-or-later
// Plans and writes an install: the new apps linked one after the other, each on whole 64 KB sectors, from the
// start of the app area (replace) or from just after the installed apps (keep), and an erased sector after them
// so the calculator's list of apps ends there.
import { InstallerError } from './errors.js';
import { SECTOR } from './calc.js';
import { linkApp } from './link.js';

// apps: [{ nwa: Uint8Array, data?: Uint8Array, name }]
// -> { start, end, image, placed: [{ name, address, size }], free }
export async function planInstall(info, scan, apps, { keep = true, nwagra = false } = {}) {
  const end = nwagra ? info.nwagraEnd : info.appsEnd;
  const start = keep ? scan.freeStart : info.appsStart;
  const ram = { ramStart: info.appsRamStart, ramLength: info.appsRamEnd - info.appsRamStart, trampoline: info.trampoline };
  const parts = [], placed = [];
  let at = start;
  for (const a of apps) {
    if (at >= end) throw new InstallerError('install.noRoom', { name: a.name }, 'No room left for ' + a.name);
    // the calculator only lists apps that start in its app area (with Nwagra, the last one may run on past it)
    if (at >= info.appsEnd) throw new InstallerError('install.pastArea', { name: a.name }, a.name + ' would start past the app area, where the calculator does not look for apps. Put the biggest app last.');
    const bin = await linkApp(a.nwa, { flashStart: at, flashLength: end - at, ...ram }, a.data);
    const padded = Math.ceil(bin.length / SECTOR) * SECTOR;
    if (at + padded > end) {
      throw new InstallerError(keep && scan.apps.length ? 'install.tooBigKeep' : 'install.tooBig', { name: a.name, over: at + padded - end }, a.name + ' doesn\'t fit: ' + mb(at + padded - end) + ' too big for the space left' +
        (keep && scan.apps.length ? ' (try without keeping the installed apps)' : ''));
    }
    const p = new Uint8Array(padded).fill(0xff);
    p.set(bin);
    parts.push(p);
    placed.push({ name: a.name, address: at, size: bin.length });
    at += padded;
  }
  if (at < end) { parts.push(new Uint8Array(SECTOR).fill(0xff)); }
  const image = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { image.set(p, o); o += p.length; }
  return { start, end, image, placed, used: at - info.appsStart, free: end - at };
}

export const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

// write the planned image and restart the calculator
export async function writeInstall(dfu, info, plan, progress) {
  if (plan.start < info.appsStart || plan.start + plan.image.length > plan.end) throw new InstallerError('install.outside', {}, 'Plan is outside the app area');
  await dfu.write(plan.start, plan.image, progress);
  // check what was written
  const back = await dfu.read(plan.start, Math.min(plan.image.length, 4096));
  for (let i = 0; i < back.length; i++) if (back[i] !== plan.image[i]) throw new InstallerError('install.verify', { address: '0x' + (plan.start + i).toString(16) }, 'Verify failed at 0x' + (plan.start + i).toString(16));
}
