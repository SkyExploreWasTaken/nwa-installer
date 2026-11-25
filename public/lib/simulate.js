// SPDX-License-Identifier: GPL-3.0-or-later
// TEST MODE: a simulated calculator, for trying the N0100 and outdated N0110/N0115 screens without one. Reached only
// through env.js's gate (development, ?debug&simulate=n0100 | n0110-old | n0115-old); the page shows a badge while it
// runs. Nothing here touches WebUSB: the device below has no USB behind it and refuses every write, and the "update"
// only moves a progress bar (simulatedFlash), so a simulated confirm never reaches the real flasher (gate.js,
// pickFlasher). With NODE_ENV=production the server doesn't serve this file at all, and the page never asks for it.
import { InstallerError } from './errors.js';

// how each simulated calculator describes itself over USB, and the memories its DFU interface shows
const PROFILES = {
  'n0100': { productName: 'NumWorks Calculator', bcd: [1, 0, 0], label: 'N0100',
    layouts: [{ name: 'Internal Flash', segments: [{ start: 0x08000000, end: 0x08100000, readable: true, writable: true }] },
      { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000, readable: true, writable: true }] }] },
  'n0110-old': { productName: 'NumWorks Calculator', bcd: [1, 0, 0], label: 'N0110',
    layouts: [{ name: 'Flash', segments: [{ start: 0x90000000, end: 0x90800000, readable: true, writable: true }] },
      { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000, readable: true, writable: true }] }] },
  'n0115-old': { productName: 'NumWorks Calculator', bcd: [1, 0, 0], label: 'N0115',
    layouts: [{ name: 'Flash', segments: [{ start: 0x90000000, end: 0x90800000, readable: true, writable: true }] },
      { name: 'SRAM', segments: [{ start: 0x20000000, end: 0x20040000, readable: true, writable: true }] }] },
};
export const SIMULATED_IDS = Object.keys(PROFILES);
// the model really inside the simulated calculator (what's printed on its back)
export const simulatedModel = (id) => PROFILES[id]?.label || null;

// the versions a simulated calculator gets when the local server has none kept (or isn't running)
export const SIMULATED_VERSIONS = {
  N0110: [{ version: '26.4.0', channel: 'stable', patch_level: 'sim2640', size: 3801088 },
    { version: '23.2.6', channel: 'stable', patch_level: 'sim2326', size: 3407872 },
    { version: '19.5.1', channel: 'stable', patch_level: 'sim1951', size: 2097152 }],
  N0115: [{ version: '26.4.0', channel: 'stable', patch_level: 'sim2640', size: 3801088 },
    { version: '24.4.0', channel: 'stable', patch_level: 'sim2440', size: 3604480 }],
};

// a DFU-like device for readInfo(): reads give erased flash, writes are refused (a simulation never writes anything)
export function simulatedDevice(id) {
  const p = PROFILES[id];
  if (!p) throw new InstallerError('sim.unknown', { id }, 'No such simulation: ' + id);
  const refuse = () => { throw new InstallerError('sim.noWrite', {}, 'Simulation: nothing is ever written'); };
  return {
    simulated: true,
    productName: p.productName + ' (simulated)',
    device: { productName: p.productName, serialNumber: 'SIMULATED-' + id.toUpperCase(),
      deviceVersionMajor: p.bcd[0], deviceVersionMinor: p.bcd[1], deviceVersionSubminor: p.bcd[2] },
    layouts: p.layouts,
    async open() {}, async close() {},
    async read(addr, n, progress) { if (progress) progress(1); return new Uint8Array(n).fill(0xff); },
    write: refuse, program: refuse,
    segmentFor(addr) {
      for (const l of p.layouts) for (const s of l.segments) if (addr >= s.start && addr < s.end) return s;
      return null;
    },
    async leave() {},
  };
}

// the "update" of a simulated calculator: a progress bar and nothing else -> { simulated: true, version }
export async function simulatedFlash(model, option, progress = () => {}, { steps = 20, ms = 60 } = {}) {
  for (let i = 1; i <= steps; i++) {
    await new Promise((ok) => setTimeout(ok, ms));
    progress(i / steps);
  }
  return { simulated: true, model, version: option.version };
}
