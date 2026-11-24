// USB DFU 1.1 with ST's DfuSe extensions, over WebUSB: what a NumWorks calculator speaks when it's plugged in.
// Works with a browser's USBDevice and with node-usb's WebUSB shim (for tests).
const DETACH = 0, DNLOAD = 1, UPLOAD = 2, GETSTATUS = 3, CLRSTATUS = 4, ABORT = 6;
export const State = { appIDLE: 0, appDETACH: 1, dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuMANIFEST_WAIT_RESET: 8, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "@External Flash /0x90000000/08*004Kg,01*032Kg,63*064Kg,64*064Kg" -> [{start, sectorSize, count, readable, ...}]
export function parseMemoryLayout(name) {
  const m = /^@([^/]+)\/(0x[0-9a-fA-F]+)\/(.*)$/.exec(name.trim());
  if (!m) return null;
  const segs = [];
  let addr = parseInt(m[2], 16);
  for (const part of m[3].split(',')) {
    const p = /^(\d+)\*(\d+)([ BKM])(.)$/.exec(part.trim());
    if (!p) continue;
    const mult = { ' ': 1, B: 1, K: 1024, M: 1048576 }[p[3]];
    const count = +p[1], size = +p[2] * mult, flags = p[4].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
    segs.push({ start: addr, end: addr + count * size, sectorSize: size, readable: !!(flags & 1),
      erasable: !!(flags & 2), writable: !!(flags & 4) });
    addr += count * size;
  }
  return { name: m[1].trim(), segments: segs };
}

export class Dfu {
  constructor(device, transferSize = 2048) {
    this.device = device;
    this.transferSize = transferSize;
    this.intf = null;
    this.layouts = [];
  }

  async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    // the DFU interface: class 0xFE (application specific), subclass 1 (DFU); its alternates name memories.
    // (Chrome on Windows often leaves interfaceName empty: then read the names from the descriptors ourselves)
    let names = null;
    const needNames = d.configuration.interfaces.some((i) => i.alternates.some((a) =>
      a.interfaceClass === 0xfe && a.interfaceSubclass === 1 && !a.interfaceName));
    if (needNames) names = await this.readInterfaceNames();
    for (const i of d.configuration.interfaces) {
      for (const a of i.alternates) {
        if (a.interfaceClass === 0xfe && a.interfaceSubclass === 1) {
          if (this.intf === null) { this.intf = i.interfaceNumber; this.alt = a.alternateSetting; }
          const name = a.interfaceName || (names && names[i.interfaceNumber + ':' + a.alternateSetting]) || '';
          const layout = parseMemoryLayout(name);
          if (layout) { layout.alt = a.alternateSetting; this.layouts.push(layout); }
        }
      }
    }
    if (this.intf === null) throw new Error('No DFU interface on this device');
    if (!this.layouts.some((l) => l.name.toLowerCase().includes('flash'))) throw new Error('Could not read the calculator\'s memory layout');
    await d.claimInterface(this.intf);
    await d.selectAlternateInterface(this.intf, this.alt);
    // leave any error or half-done transfer behind
    const st = await this.getStatus();
    if (st.state === State.dfuERROR) await this.clearStatus();
    else if (st.state !== State.dfuIDLE) await this.abortToIdle();
  }

  // standard GET_DESCRIPTOR requests to the device
  async getDescriptor(type, index, length, langId = 0) {
    const r = await this.device.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6,
      value: (type << 8) | index, index: langId }, length);
    if (r.status !== 'ok') throw new Error('GET_DESCRIPTOR failed: ' + r.status);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  // { "interface:alternate": name } from the configuration descriptor and its string descriptors
  async readInterfaceNames() {
    const cfgIndex = 0;
    const head = await this.getDescriptor(2, cfgIndex, 9);
    const total = head[2] | (head[3] << 8);
    const cfg = await this.getDescriptor(2, cfgIndex, total);
    const langs = await this.getDescriptor(3, 0, 255);
    const lang = langs.length >= 4 ? langs[2] | (langs[3] << 8) : 0x0409;
    const out = {};
    for (let o = 0; o + 1 < cfg.length && cfg[o] > 0; o += cfg[o]) {
      if (cfg[o + 1] !== 4) continue;  // interface descriptor
      const num = cfg[o + 2], alt = cfg[o + 3], iName = cfg[o + 8];
      if (!iName) continue;
      const s = await this.getDescriptor(3, iName, 255, lang);
      let name = '';
      for (let i = 2; i + 1 < s[0] && i + 1 < s.length; i += 2) name += String.fromCharCode(s[i] | (s[i + 1] << 8));
      out[num + ':' + alt] = name;
    }
    return out;
  }

  async close() {
    try { await this.device.releaseInterface(this.intf); } catch (e) { /* gone already */ }
    try { await this.device.close(); } catch (e) { /* gone already */ }
  }

  segmentFor(addr) {
    for (const l of this.layouts) for (const s of l.segments) if (addr >= s.start && addr < s.end) return s;
    return null;
  }

  // each memory (flash, RAM) is its own alternate setting of the DFU interface
  async selectFor(addr) {
    let alt = 0;
    for (const l of this.layouts) for (const s of l.segments) if (addr >= s.start && addr < s.end) alt = l.alt;
    if (alt !== this.alt) {
      await this.device.selectAlternateInterface(this.intf, alt);
      this.alt = alt;
    }
  }

  async out(request, data, value = 0) {
    const r = await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request,
      value, index: this.intf }, data || new ArrayBuffer(0));
    if (r.status !== 'ok') throw new Error('DFU request ' + request + ' failed: ' + r.status);
    return r.bytesWritten;
  }

  async in(request, length, value = 0) {
    const r = await this.device.controlTransferIn({ requestType: 'class', recipient: 'interface', request,
      value, index: this.intf }, length);
    if (r.status !== 'ok') throw new Error('DFU request ' + request + ' failed: ' + r.status);
    return r.data;
  }

  async getStatus() {
    const d = await this.in(GETSTATUS, 6);
    return { status: d.getUint8(0), pollTimeout: d.getUint32(1, true) & 0xffffff, state: d.getUint8(4) };
  }

  clearStatus() { return this.out(CLRSTATUS); }
  abort() { return this.out(ABORT); }

  async abortToIdle() {
    await this.abort();
    let st = await this.getStatus();
    if (st.state === State.dfuERROR) { await this.clearStatus(); st = await this.getStatus(); }
    if (st.state !== State.dfuIDLE) throw new Error('Could not get the calculator to DFU idle (state ' + st.state + ')');
  }

  // after a DNLOAD: wait while the device is busy, then check it went fine
  async pollUntilIdle(want = State.dfuDNLOAD_IDLE) {
    let st = await this.getStatus();
    while (st.state !== want && st.state !== State.dfuERROR) {
      await sleep(st.pollTimeout || 1);
      st = await this.getStatus();
    }
    if (st.state === State.dfuERROR || st.status !== 0) {
      await this.clearStatus().catch(() => {});
      throw new Error('DFU error, status ' + st.status);
    }
    return st;
  }

  async dfuseCommand(cmd, addr) {
    const b = new Uint8Array(5);
    b[0] = cmd;
    new DataView(b.buffer).setUint32(1, addr >>> 0, true);
    await this.out(DNLOAD, b, 0);
    await this.pollUntilIdle();
  }
  setAddress(addr) { return this.dfuseCommand(0x21, addr); }
  eraseSector(addr) { return this.dfuseCommand(0x41, addr); }

  // read len bytes at addr
  async read(addr, len, progress) {
    const out = new Uint8Array(len);
    let done = 0;
    while (done < len) {
      // one address per run of blocks: block n (from 2) reads at addr + (n - 2) * transferSize
      const runStart = addr + done;
      await this.selectFor(runStart);
      const st = await this.getStatus();
      if (st.state !== State.dfuIDLE) await this.abortToIdle();
      await this.setAddress(runStart);
      await this.abortToIdle();
      let block = 2;
      while (done < len && block < 0xffff) {
        const n = Math.min(this.transferSize, len - done);
        const d = await this.in(UPLOAD, n, block);
        const got = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        out.set(got.subarray(0, n), done);
        done += n;
        block++;
        if (progress) progress(done / len);
        if (got.length < n) break;
      }
      await this.abortToIdle();
    }
    return out;
  }

  // erase the sectors under [addr, addr + data.length) and write data there
  async write(addr, data, progress) {
    const total = data.length;
    // erase first: each sector the data touches
    const sectors = [];
    for (let a = addr; a < addr + total;) {
      const s = this.segmentFor(a);
      if (!s || !s.erasable) throw new Error('Address 0x' + a.toString(16) + ' is not erasable flash');
      const start = a - ((a - s.start) % s.sectorSize);
      sectors.push(start);
      a = start + s.sectorSize;
    }
    if (sectors[0] !== addr) throw new Error('Writes must start on a sector boundary');
    await this.selectFor(addr);
    let i = 0;
    for (const s of sectors) {
      await this.eraseSector(s);
      if (progress) progress(0.3 * (++i / sectors.length));
    }
    await this.program(addr, data, progress && ((p) => progress(0.3 + 0.7 * p)));
  }

  // write data at addr without erasing (RAM, or flash erased already)
  async program(addr, data, progress) {
    await this.selectFor(addr);
    const st = await this.getStatus();
    if (st.state !== State.dfuIDLE) await this.abortToIdle();
    const total = data.length;
    let done = 0;
    while (done < total) {
      const n = Math.min(this.transferSize, total - done);
      await this.setAddress(addr + done);
      await this.out(DNLOAD, data.subarray(done, done + n), 2);
      await this.pollUntilIdle();
      done += n;
      if (progress) progress(done / total);
    }
    await this.abortToIdle();
  }

  // leave DFU: the calculator restarts (its software at addr)
  async leave(addr) {
    await this.selectFor(addr);
    await this.setAddress(addr);
    await this.out(DNLOAD, new ArrayBuffer(0), 2);
    try { await this.getStatus(); } catch (e) { /* it resets right away */ }
  }
}
