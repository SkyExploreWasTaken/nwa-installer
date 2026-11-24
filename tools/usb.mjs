// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by the command-line tools: the page's own code (public/lib), run in Node against the plugged-in calculator
// through node-usb's WebUSB.
import { createRequire } from 'module';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Dfu } from '../public/lib/dfu.js';
import { readInfo } from '../public/lib/calc.js';
import { setTools } from '../public/lib/link.js';

const require = createRequire(import.meta.url);
export const repo = (rel) => fileURLToPath(new URL('../' + rel, import.meta.url));

function nodeUsb() {
  // this folder's node_modules (npm install), or a sibling project's
  for (const p of ['usb', '../../numworks/node_modules/usb']) {
    try { return require(p); } catch (e) { /* next */ }
  }
  throw new Error('node-usb not found: run npm install');
}

// -> { dev, dfu, info }, the DFU interface open
export async function openCalculator() {
  const { WebUSB } = nodeUsb();
  const dev = (await new WebUSB({ allowAllDevices: true }).getDevices()).find((d) => d.vendorId === 0x0483);
  if (!dev) throw new Error('No calculator found: plug it in and unlock it (and close pages or programs using it)');
  const dfu = new Dfu(dev);
  await dfu.open();
  return { dev, dfu, info: await readInfo(dfu) };
}

// the linker, from public/vendor (npm run setup)
export function loadLinker() {
  const v = (f) => repo('public/vendor/' + f);
  setTools({ ld: [require(v('ld.js')), fs.readFileSync(v('ld.wasm'))], oc: [require(v('objcopy.js')), fs.readFileSync(v('objcopy.wasm'))],
    eadk: new Uint8Array(fs.readFileSync(v('eadk.o'))) });
}

export const percent = (p) => process.stdout.write('\r' + (p * 100).toFixed(0) + '%  ');
