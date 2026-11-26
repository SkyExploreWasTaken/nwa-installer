// SPDX-License-Identifier: GPL-3.0-or-later
// What's on a NumWorks calculator (Epsilon 16 and later, N0110/N0115/N0120): its firmware headers and the
// external apps in its app area. All of it read over DFU, nothing written.
import { InstallerError } from './errors.js';
import { detectModel, usbVersionOf, pickableModels, versionMatches } from './model.js';
import { checkOfficial } from './official.js';

// refuses a calculator that doesn't run official software (official.js), with what was found as the code
function unofficial(check) {
  throw new InstallerError('calc.unofficial.' + check.reason, {}, `This calculator runs unofficial software (${check.reason}), which Nwa Toolkit doesn't support. Reinstall NumWorks' official Epsilon, then connect again.`);
}
export const SECTOR = 0x10000;            // apps start on 64 KB sectors
export const FLASH_END = 0x90800000;
export const SLOT_B = 0x90400000;      // the second copy of the software (its kernel header 8 bytes in)      // end of the 8 MB external flash
export const APP_MAGIC = 0xdec0beba;
// (these header magics are compared as bytes, in this order)
const MAGIC = { kernel: 'f00dc0de', userland: 'feedc0de', slot: 'badbeeef' };
const is = (b, o, m) => b.length >= o + 4 && [...b.subarray(o, o + 4)].map((x) => x.toString(16).padStart(2, '0')).join('') === m;
const USERLAND_ISR_SIZE = 8;

const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const cstr = (b, o, max = 64) => {
  let s = '';
  for (let i = o; i < Math.min(b.length, o + max) && b[i]; i++) s += String.fromCharCode(b[i]);
  return s;
};
export const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

// chosenModel: the model the user picked for a calculator whose USB version isn't known (model.js), checked against its memories
// manual: the model is always picked (Android, whose USB version can't be trusted); expectVersion: the software version
// the user read in Settings > About, which must match what the calculator says
export async function readInfo(dfu, { chosenModel = null, manual = false, expectVersion = null } = {}) {
  const productName = dfu.device?.productName || dfu.productName || '';
  const flashStrings = dfu.layouts.map((l) => l.raw).filter(Boolean);
  if (productName === 'Upsilon Bootloader') unofficial(checkOfficial({ productName }));
  // the model, from the USB descriptor (model.js); a calculator this page can't work with is refused, saying why
  const m = detectModel({ usbVersion: usbVersionOf(dfu.device), productName, serialNumber: dfu.device?.serialNumber || '', layouts: dfu.layouts, chosen: chosenModel, manual });
  // the N0100: refused (no external flash, so no app area; no bootloader; NumWorks stopped updating it)
  if (m.refuse === 'calc.n0100') throw new InstallerError('calc.n0100', {}, 'The N0100 is too old for Nwa Toolkit: it has no storage for .nwa apps, and NumWorks has stopped updating it, so Nwa Toolkit cannot do anything with it.');
  // an N0110/N0115 on outdated firmware: nothing read (its memory isn't laid out as below), and the page only offers
  // what gate.js allows: { model: null, limited: 'outdated' }
  if (m.limited === 'outdated') return { model: null, limited: 'outdated', serial: dfu.device?.serialNumber || null };
  if (m.refuse === 'calc.updateFirst') throw new InstallerError('calc.updateFirst', {}, 'This calculator runs old or unofficial software that does not say which model it is. Update it first on https://my.numworks.com/devices/upgrade, then connect again.');
  if (m.refuse === 'calc.pickMismatch') throw new InstallerError('calc.pickMismatch', { bcd: m.bcd, model: m.model }, `The picked model ${m.model} doesn't match this calculator's memories (USB version ${m.bcd}). Check the label on the back of the calculator.`);
  if (m.refuse) {
    const e = new InstallerError('calc.unknownModel', { bcd: m.bcd }, 'This calculator model (USB version ' + m.bcd + ') is not supported by Nwa Toolkit.');
    // the models the user may pick instead (the page asks), when the memories fit some
    e.pick = pickableModels({ productName, layouts: dfu.layouts });
    throw e;
  }
  const info = { model: m.model, picked: !!m.picked, serial: dfu.device?.serialNumber || null, ramStart: 0x20000000 };
  // the N0120 has its RAM at 0x24000000: its DFU memories say so
  for (const l of dfu.layouts) for (const s of l.segments) if (s.start === 0x24000000) info.ramStart = 0x24000000;

  // the bootloader leaves where the running slot's kernel and userland headers are at the start of RAM
  const slot = await dfu.read(info.ramStart, 16);
  if (!is(slot, 0, MAGIC.slot) || !is(slot, 12, MAGIC.slot)) {
    throw new InstallerError('calc.tooOld', {}, 'This calculator\'s software is not supported (no bootloader slot info: Epsilon 15 or older, or a fork without a bootloader). Install official Epsilon from https://my.numworks.com/devices/upgrade, then connect again.');
  }
  info.kernelHeader = u32(slot, 4);
  info.userlandHeader = u32(slot, 8);

  const k = await dfu.read(info.kernelHeader, 24);
  if (!is(k, 0, MAGIC.kernel)) throw new InstallerError('calc.noKernel', {}, 'The kernel header was not where it should be');
  info.version = cstr(k, 4, 8);
  info.patch = cstr(k, 12, 8);
  if (expectVersion != null && !versionMatches(expectVersion, info.version)) {
    throw new InstallerError('calc.pickVersionMismatch', { entered: expectVersion, version: info.version }, `The version you entered (${expectVersion}) doesn't match the calculator's (${info.version}). Check Settings > About on the calculator.`);
  }

  const u = await dfu.read(info.userlandHeader, 48);
  if (!is(u, 0, MAGIC.userland)) throw new InstallerError('calc.noUserland', {}, 'The userland header was not where it should be');
  info.userlandVersion = cstr(u, 4, 8);
  let o = 12;
  info.storageAddress = u32(u, o); o += 4;
  info.storageSize = u32(u, o); o += 4;
  info.appsStart = u32(u, o); o += 4;
  info.appsEnd = u32(u, o); o += 4;
  if (!is(u, o, MAGIC.userland)) {
    info.appsRamStart = u32(u, o); o += 4;
    info.appsRamEnd = u32(u, o); o += 4;
    if (!is(u, o, MAGIC.userland)) { o += 8; }
  }
  if (!is(u, o, MAGIC.userland)) throw new InstallerError('calc.unknownUserland', {}, 'The userland header is not one this page knows');
  // the trampoline table the apps' EADK calls jump through: right after the header and the userland's ISR words
  info.trampoline = info.userlandHeader + o + 4 + USERLAND_ISR_SIZE;
  // official software only: the running slot's DFU string, and the fork markers right after the userland header
  const after = await dfu.read(info.userlandHeader + o + 4, 96);
  info.firmwareCheck = checkOfficial({ productName, flashStrings, afterUserland: after });
  info.dfuStrings = flashStrings;
  if (!info.firmwareCheck.official) unofficial(info.firmwareCheck);
  info.major = parseInt(info.version, 10) || 0;
  // Nwagra: apps may run on past the app area to the end of the flash, when the running software is below the app
  // area (slot A). (On Epsilon 26 too: only NumWorks' installer page gets its size wrong there, NaN.) It writes over
  // the calculator's spare copy of its software, slot B, at 0x90400000: the calculator runs from slot A.
  info.slot = info.userlandHeader < info.appsStart ? 'A' : 'B';
  info.nwagraOk = info.slot === 'A' && info.kernelHeader < info.appsStart && info.appsEnd <= SLOT_B;
  info.nwagraEnd = FLASH_END;
  if (info.nwagraOk) {
    // what's in slot B now: a copy of the software (its version), or apps / nothing
    const kb = await dfu.read(SLOT_B + 8, 24);
    info.slotB = is(kb, 0, MAGIC.kernel) ? cstr(kb, 4, 8) : null;
  }
  return info;
}

export function parseAppHeader(b, address) {
  if (b.length < 32 || u32(b, 0) !== APP_MAGIC || u32(b, 28) !== APP_MAGIC) return null;
  return { address, apiLevel: u32(b, 4), nameOffset: u32(b, 8), iconSize: u32(b, 12), iconOffset: u32(b, 16),
    entryOffset: u32(b, 20), codeEnd: u32(b, 24) };
}

const allFF = (b) => { for (let i = 0; i < b.length; i++) if (b[i] !== 0xff) return false; return true; };

// The installed apps, one after the other from the start of the app area, each on its own 64 KB sectors, the
// list ending at the first sector that doesn't start a new one. For each: its address, name and size (up to the
// last byte that isn't erased flash), and where the free space after them starts. The calculator only lists apps
// that start in its app area, but one may run on past it (Nwagra): its size is measured to the end of the flash.
export async function scanApps(dfu, info, { progress } = {}) {
  const apps = [];
  const end = FLASH_END;
  let at = info.appsStart;
  while (at < info.appsEnd) {
    const h = parseAppHeader(await dfu.read(at, 32), at);
    if (!h) break;
    const nm = await dfu.read(at + h.nameOffset, 64);
    h.name = cstr(nm, 0, 64);
    // its code and constants end at codeEnd; its .data comes right after: read on sector by sector to the first
    // one that's erased or starts another app
    let s = at + Math.floor(h.codeEnd / SECTOR) * SECTOR;
    let last = at + h.codeEnd;
    for (; s < end; s += SECTOR) {
      const sec = await dfu.read(s, Math.min(SECTOR, end - s));
      if (s > at && (parseAppHeader(sec.subarray(0, 32), s) || allFF(sec))) break;
      for (let i = sec.length - 1; i >= 0; i--) if (sec[i] !== 0xff) { last = Math.max(last, s + i + 1); break; }
      if (progress) progress(Math.min(1, (s - info.appsStart) / (end - info.appsStart)));
    }
    h.size = last - at;
    h.sectors = Math.ceil(h.size / SECTOR);
    apps.push(h);
    at += h.sectors * SECTOR;
  }
  if (progress) progress(1);
  return { apps, freeStart: at };
}
