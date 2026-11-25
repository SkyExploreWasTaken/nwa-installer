// SPDX-License-Identifier: GPL-3.0-or-later
// Calculators this installer only half supports or refuses, and what the page may do with them. No DOM here: app.js
// draws it, tools/test-gate.mjs tests it.
//  - The N0100: refused when it connects (model.js, calc.js): too old, no external flash so no app area for .nwa apps,
//    and NumWorks stopped updating it. No firmware is ever written to it either (assertFirmwareAllowed, checked by
//    every firmware path, and the server never keeps N0100 firmware).
//  - An N0110 or N0115 on outdated firmware (it shows USB version 1.0.0 and can't say which of the two it is): never
//    updated by itself. OutdatedFlow makes the user pick the model printed on the back, then lists every firmware this
//    computer keeps for that model (oldest first, the oldest picked), and flashes only after an explicit confirm of
//    the version shown. The user may skip instead: nothing is written, and the page shows a very big warning once;
//    after its OK (limitedView), the usual page, where what can't work on that firmware says so (limitedActionError)
//    instead of pretending. Updating it later: connect again, pick, confirm.
import { InstallerError } from './errors.js';
import { compareVersions } from './fwchoice.js';

export const OUTDATED_MODELS = ['N0110', 'N0115'];

// throws unless firmware may be written to this model: never to the N0100
export function assertFirmwareAllowed(model) {
  if (String(model || '').trim().toUpperCase() === 'N0100') {
    throw new InstallerError('calc.n0100.noFlash', {}, 'The N0100 is too old: this installer never updates its firmware.');
  }
}

// every version kept for a model, from /api/firmware/<model>.json: oldest first, a version kept in both channels
// listed once -> [{ version, channel, patch, size }]
export function cachedVersions(info) {
  const seen = new Map();
  for (const v of info?.versions || []) {
    if (!v || typeof v.version !== 'string' || !v.version || seen.has(v.version)) continue;
    seen.set(v.version, { version: v.version, channel: v.channel || 'stable', patch: v.patch_level ?? null, size: v.size ?? 0 });
  }
  return [...seen.values()].sort((a, b) => compareVersions(a.version, b.version));
}

// The steps for an outdated N0110/N0115:
//   'model'    pick N0110 or N0115 (chooseModel)
//   'loading'  reading what this computer keeps for it
//   'version'  options listed (oldest first), selected = the oldest; select() another; confirm(version) flashes it
//   'none'     nothing kept for that model: nothing can be flashed (chooseModel again, or skip)
//   'error'    the list could not be read (error); chooseModel again, or skip
//   'flashing' -> 'done' (or 'error' when the flash failed)
//   'skipped'  the user chose not to update: nothing is ever flashed from here on
// loadInfo(model) -> /api/firmware/<model>.json; flash(model, option) does the writing (only ever called by confirm).
export class OutdatedFlow {
  constructor({ loadInfo, flash, onChange = () => {} }) {
    Object.assign(this, { loadInfo, flash, onChange });
    this.step = 'model';
    this.model = null;
    this.options = [];
    this.selected = null;
    this.error = null;
  }

  set(changes) { Object.assign(this, changes); this.onChange(this); }

  async chooseModel(model) {
    if (this.step === 'skipped' || this.step === 'flashing' || this.step === 'done') return;
    if (!OUTDATED_MODELS.includes(model)) throw new InstallerError('gate.badModel', { model }, 'Pick N0110 or N0115');
    this.set({ step: 'loading', model, options: [], selected: null, error: null });
    let options;
    try { options = cachedVersions(await this.loadInfo(model)); } catch (e) {
      if (this.model === model && this.step === 'loading') this.set({ step: 'error', error: e });
      return;
    }
    if (this.model !== model || this.step !== 'loading') return;  // (another model was picked meanwhile, or skipped)
    this.set(options.length ? { step: 'version', options, selected: options[0].version } : { step: 'none' });
  }

  select(version) {
    if (this.step !== 'version' || !this.options.some((o) => o.version === version)) return false;
    this.set({ selected: version });
    return true;
  }

  skip() {
    if (this.step === 'flashing' || this.step === 'done') return false;
    this.set({ step: 'skipped', options: [], selected: null });
    return true;
  }

  // the user confirmed flashing this version (the one the page showed them): flashes it, and only it
  async confirm(version) {
    if (this.step !== 'version' || !version || version !== this.selected) return false;
    assertFirmwareAllowed(this.model);
    const option = this.options.find((o) => o.version === version);
    this.set({ step: 'flashing', error: null });
    try {
      const r = await this.flash(this.model, option);
      this.set({ step: 'done', result: r });
    } catch (e) {
      this.set({ step: 'error', error: e });
      throw e;
    }
    return true;
  }
}

// which flasher the outdated flow gets: the simulated one whenever a simulation runs (TEST MODE, simulate.js), and then
// never the real one; the real one otherwise
export function pickFlasher({ simulate, real, simulated }) {
  if (!simulate) return real;
  if (typeof simulated !== 'function') throw new InstallerError('sim.noWrite', {}, 'Simulation: nothing is ever written');
  return simulated;
}

// What the page shows for the calculator connected now:
//   warning: 'outdated' | null  the very big warning after Skip update, until its OK (dismissed, once per connection)
//   normal: the usual sections (apps, install, software)   outdatedFlow: the outdated N0110/N0115 model/version step
export function limitedView({ connected, limited = null, outdatedStep = null, dismissed = false }) {
  if (!connected) return { warning: null, normal: false, outdatedFlow: false };
  if (!limited) return { warning: null, normal: true, outdatedFlow: false };
  const skipped = limited === 'outdated' && outdatedStep === 'skipped';
  return { warning: skipped && !dismissed ? 'outdated' : null, normal: skipped && dismissed, outdatedFlow: limited === 'outdated' && !skipped };
}

// what an app or backup action says on outdated firmware (Epsilon 15 or older), whose missing bootloader headers
// would say where its apps and files are: nothing is read or written
export function limitedActionError() {
  return new InstallerError('limited.outdated', {}, "Not possible with this calculator's outdated firmware: it does not say where its apps and files are. Connect again and update it first.");
}

// Check for updates on outdated firmware: only through its own update step (its model is unknown here); and never
// for the N0100 (assertFirmwareAllowed)
export function limitedFirmwareError(limited, model) {
  assertFirmwareAllowed(model);
  if (limited === 'outdated') return new InstallerError('limited.outdatedFw', {}, "This calculator's firmware is outdated and its model unknown: connect again, pick its model and a version, and confirm.");
  return null;
}
