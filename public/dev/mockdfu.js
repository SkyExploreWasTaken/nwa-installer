// SPDX-License-Identifier: GPL-3.0-or-later
// A pretend calculator for testing the page without one (index.html?mock): memory from dev/mock/ (saved by
// dump-mock.mjs), reads and writes in memory only.
import { State } from '../lib/dfu.js';
export async function mockDevice() {
  const meta = await (await fetch('dev/mock/regions.json')).json();
  // the whole external flash, erased, with the saved regions in it; the saved RAM regions on their own
  const flash = { address: 0x90000000, data: new Uint8Array(0x800000).fill(0xff) };
  const regions = [flash];
  for (const r of meta.regions) {
    const data = new Uint8Array(await (await fetch('dev/mock/' + r.file)).arrayBuffer());
    if (r.address >= flash.address) flash.data.set(data, r.address - flash.address);
    else regions.push({ address: r.address, data });
  }
  const find = (a, n) => {
    const r = regions.find((x) => a >= x.address && a + n <= x.address + x.data.length);
    if (!r) throw new Error('mock: nothing at 0x' + a.toString(16));
    return r.data.subarray(a - r.address, a - r.address + n);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    productName: meta.product + ' (mock)', layouts: meta.layouts,
    // (the descriptor of the calculator the mock was recorded from: an N0120)
    device: { productName: meta.product, serialNumber: 'mock', deviceVersionMajor: 1, deviceVersionMinor: 2, deviceVersionSubminor: 0 },
    async open() {}, async close() {},
    async read(a, n, progress) { await sleep(5); const b = find(a, n).slice(); if (progress) progress(1); return b; },
    async write(a, data, progress) {
      for (let i = 0; i < 20; i++) { await sleep(40); if (progress) progress((i + 1) / 20); }
      find(a, data.length).set(data);
    },
    async program(a, data) { find(a, data.length).set(data); },
    segmentFor(addr) {
      for (const l of meta.layouts) for (const s of l.segments) if (addr >= s.start && addr < s.end) return s;
      return null;
    },
    async leave() { this.left = true; },
    State,
  };
}
