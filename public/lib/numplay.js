// SPDX-License-Identifier: GPL-3.0-or-later
// Makes a NumPlay.nwa from NumPlay's kit, in the page: NumPlay's launcher and the games you pick, linked the way
// NumPlay Studio links them. NumPlay (https://github.com/Mason363/NumPlay, GPL-3.0) is Mason Chen's: its kit (the
// launcher's and games' objects, kit.json), its apps.js (which turns a .nwa into a NumPlay game) and its pico.js (which
// reads PICO-8 carts) are fetched from NumPlay's site through the local server (numplay.js), not part of this repository.
import { InstallerError } from './errors.js';
import { ld, objcopy } from './link.js';
import { MEGA_DRIVE, ROM_HEAD, romFrom, romSize, romTable } from './roms.js';

export const KIT = '/numplay/kit/';
const APPS_JS = '/numplay/apps.js', PICO_JS = '/numplay/pico.js';
export const MAX_CARTS = 64;                 // (NumPico holds 64 carts at most)
export const MAX_GAMES = 96;                 // (NumPlay's launcher holds 96 games and apps at most)
// the launcher's looks: its icon and name on the calculator
export const VARIANTS = { NumPlay: 'NumPlay', 'NumPlay-Matrices': 'Matrices', 'NumPlay-Invisible': ' ' };
// what opens the launcher when it's dressed as the Matrices app (in order: the launcher's own numbering)
export const SECRETS = ['x,n,t key', 'var key', 'Toolbox key', 'π key', '√ key', 'Menu: Examples', 'Konami code'];
// what a .nwa app may leave for the calculator or the launcher to provide when it becomes a game of NumPlay
const PROVIDED = /^(eadk_|_heap_end$|_data_section_|_bss_section_|np_keyboard_scan$|np_event_get$|np_display_draw_string$|np_sbrk$|numplay_launcher$|__sf$|_printf_float$)/;

const align4 = (n) => (n + 3) & ~3;

// ------------------------------------------------------------------ fetching the kit
// a failed fetch: the server's { error, code, params } when it sent one, else the HTTP status
async function httpError(path, r) {
  const j = await r.clone().json().catch(() => null);
  return j?.code ? new InstallerError(j.code, j.params || {}, j.error) : new InstallerError('net.http', { file: path, status: r.status }, path + ': HTTP ' + r.status);
}
const cache = new Map();
function fetchBytes(path) {
  if (!cache.has(path)) {
    const p = fetch(path).then(async (r) => {
      if (!r.ok) throw await httpError(path, r);
      const body = path.endsWith('.gz') ? r.body.pipeThrough(new DecompressionStream('gzip')) : r.body;
      return new Uint8Array(await new Response(body).arrayBuffer());
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path);
}
const fetchJson = (path) => fetch(path).then(async (r) => { if (!r.ok) throw await httpError(path, r); return r.json(); });

// NumPlay's own scripts, loaded as NumPlay Studio loads them: each sets a global (npApps, npPico)
const scripts = {};
function loadScript(src, global) {
  scripts[src] = scripts[src] || new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => ok(window[global]);
    s.onerror = () => { delete scripts[src]; s.remove(); no(new InstallerError('numplay.script', { file: src.split('/').pop() }, 'Could not load NumPlay\'s ' + src.split('/').pop())); };
    document.head.appendChild(s);
  });
  return scripts[src];
}
const loadAppsJs = () => loadScript(APPS_JS, 'npApps');
const loadPicoJs = () => loadScript(PICO_JS, 'npPico');

// ------------------------------------------------------------------ small ELF objects
// A relocatable ARM object with one section per entry, each with a global symbol at its start:
// [{ section, symbol, data, align }]
export function elfObject(entries) {
  const enc = new TextEncoder();
  const names = ['', ...entries.map((e) => e.section), '.symtab', '.strtab', '.shstrtab'];
  const shstr = enc.encode(names.join('\0') + '\0');
  const strtab = enc.encode(['', ...entries.map((e) => e.symbol)].join('\0') + '\0');
  const nameAt = (list, i) => list.slice(0, i).reduce((n, s) => n + enc.encode(s).length + 1, 0);

  let at = 52;
  const offsets = entries.map((e) => { at = align4(at); const o = at; at += e.data.length; return o; });
  const symOff = align4(at), symSize = 16 * (entries.length + 1);
  const strOff = symOff + symSize, shstrOff = strOff + strtab.length;
  const shOff = align4(shstrOff + shstr.length), count = entries.length + 4;
  const b = new Uint8Array(shOff + 40 * count), v = new DataView(b.buffer);

  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);                                  // ELF32, little endian
  v.setUint16(16, 1, true); v.setUint16(18, 40, true); v.setUint32(20, 1, true); // relocatable, ARM
  v.setUint32(32, shOff, true); v.setUint16(40, 52, true); v.setUint16(46, 40, true);
  v.setUint16(48, count, true); v.setUint16(50, count - 1, true);
  entries.forEach((e, i) => {
    b.set(e.data, offsets[i]);
    const s = symOff + 16 * (i + 1);                                          // symbol: global object
    v.setUint32(s, nameAt(['', ...entries.map((x) => x.symbol)], i + 1), true);
    v.setUint32(s + 8, e.data.length, true); b[s + 12] = 0x11; v.setUint16(s + 14, i + 1, true);
  });
  b.set(strtab, strOff);
  b.set(shstr, shstrOff);
  const header = (i, type, flags, off, size, link, info, align, entsize) => {
    [nameAt(names, i), type, flags, 0, off, size, link, info, align, entsize].forEach((x, k) => v.setUint32(shOff + 40 * i + 4 * k, x, true));
  };
  entries.forEach((e, i) => header(i + 1, 1, 2, offsets[i], e.data.length, 0, 0, e.align || 1, 0));  // allocated, read-only
  const n = entries.length;
  header(n + 1, 2, 0, symOff, symSize, n + 2, 1, 4, 16);
  header(n + 2, 3, 0, strOff, strtab.length, 0, 0, 1, 0);
  header(n + 3, 3, 0, shstrOff, shstr.length, 0, 0, 1, 0);
  return b;
}

// the launcher's name on the calculator and how it opens: 'D', 1, flags (1: as Matrices, 2: no hint), the secret
function settingsObject({ name, matrices, hint, secret }) {
  const enc = new TextEncoder().encode((name || ' ').slice(0, 20));
  const z = new Uint8Array(enc.length + 1);
  z.set(enc);
  return elfObject([
    { section: '.rodata.eadk_app_name', symbol: 'eadk_app_name', data: z },
    { section: '.rodata.np_defaults', symbol: 'np_defaults', data: new Uint8Array([0x44, 1, (matrices ? 1 : 0) | (hint ? 0 : 2), secret | 0]) },
  ]);
}

// ------------------------------------------------------------------ the kit
export class NumPlayKit {
  static async load() {
    const k = new NumPlayKit();
    k.en = await fetchJson(KIT + 'kit.json');
    k.langs = { en: k.en };
    k.en.byId = Object.fromEntries(k.en.games.map((g) => [g.id, g]));
    k.extras = [];
    return k;
  }

  get version() { return this.en.version; }
  get languages() { return this.en.langs || ['en']; }
  get spaces() { return this.en.spaces || []; }

  // the games you can pick: NumPlay's own, without the two that take your own files (Retro-Go, NumPico)
  games() { return this.en.games.filter((g) => !g.roms && !g.carts); }
  // Retro-Go, the emulator that plays your Game Boy, NES and Sega games, and NumPico, which plays your PICO-8 carts
  get retroGo() { return this.en.games.find((g) => g.roms) || null; }
  get numPico() { return this.en.games.find((g) => g.carts) || null; }
  get romSystems() { return (this.retroGo && this.retroGo.systems) || [1, 2, 3]; }
  game(id, lang = 'en') { const k = this.langs[lang] || this.en; return (k.byId && k.byId[id]) || this.en.byId[id]; }
  iconUrl(id) { return this.en.byId[id] && this.en.byId[id].icon ? KIT + 'icons/' + id + '.png' : null; }
  variantUrl(v) { return KIT + 'variants/' + v + '.png'; }

  async language(lang) {
    if (!this.langs[lang]) {
      const k = await fetchJson(KIT + lang + '/kit.json');
      k.byId = Object.fromEntries(k.games.map((g) => [g.id, g]));
      this.langs[lang] = k;
    }
    return this.langs[lang];
  }

  // NumPlay's own bytes: with the library its games (and Retro-Go) call, or only the launcher when the games are all
  // big ones
  launcherBytes(ids, roms, lang = 'en', carts = []) {
    const k = this.langs[lang] || this.en;
    return ids.some((id) => !this.en.byId[id].xl) || roms.length || carts.length ? k.base : k.baseAlone || k.base;
  }
  // about what Retro-Go as an app of its own (the only way it's made now) takes in the calculator's flash
  estimateRetroGo(roms) {
    if (!roms.length) return 0;
    return (this.retroGo.appFlash || this.retroGo.flash) + ROM_HEAD + roms.reduce((n, r) => n + r.flash, 0);
  }
  // about what a NumPlay of these games, extra apps, ROMs and carts takes in the calculator's flash
  estimate({ ids = [], extras = [], roms = [], carts = [], lang = 'en' }) {
    const romBytes = roms.reduce((n, r) => n + r.flash, 0);
    if (retroGoAlone(roms)) return (this.retroGo.appFlash || this.retroGo.flash) + ROM_HEAD + romBytes;
    if (!ids.length && !extras.length && !roms.length && !carts.length) return 0;
    let n = this.launcherBytes(ids, roms, lang, carts) + ids.reduce((t, id) => t + this.game(id, lang).flash, 0)
      + extras.reduce((t, a) => t + a.flash, 0) + this.en.runtime;
    if (roms.length) n += this.game(this.retroGo.id, lang).flash + ROM_HEAD + romBytes;
    if (carts.length) n += this.game(this.numPico.id, lang).flash + 12 + carts.reduce((t, c) => t + c.flash, 0);
    return n;
  }

  // ---------------------------------------------------------------- your own games, for Retro-Go and NumPico
  // a Game Boy, NES or Sega game's file -> { sys, name, bytes, flash }
  romFrom(bytes, fileName) {
    const r = romFrom(bytes, fileName, this.romSystems);
    return { ...r, flash: romSize(r) };
  }
  // a PICO-8 cart (.p8 or .p8.png) -> { name, title, rom, code, label, flash }, read by NumPlay's pico.js
  async cartFrom(bytes, fileName) {
    const P = await loadPicoJs();
    let c;
    try { c = await P.readCart(bytes, fileName); } catch (e) { throw new InstallerError('numplay.badCart', { file: fileName }, fileName + ' isn\'t a PICO-8 cart NumPico can read'); }
    return { ...c, title: new TextDecoder().decode(c.name) || 'cart', flash: P.cartBytes(c) };
  }
  // a cart's label as RGBA pixels (128 x 128), for a picture of it
  async cartLabel(c) { return c.label ? (await loadPicoJs()).labelRGBA(c.label) : null; }

  // ---------------------------------------------------------------- your own apps as games of NumPlay
  // An app's .nwa becomes a NumPlay game the way NumPlay Studio makes one (its apps.js does the object work):
  // ld -r with the kit's module script, objcopy's renames to the launcher's functions, then its entry and card.
  async extraFrom(bytes, fileName, key) {
    const A = await loadAppsJs();
    const k = this.en;
    if (!k.script.module) throw new InstallerError('numplay.noApps', {}, 'This NumPlay kit can\'t take apps');
    const id = 'app' + key, index = 200 + key, info = A.appInfo(bytes);
    const o1 = await ld(['-r', '-d', '-z', 'noexecstack', '--force-group-allocation', '-T', 'module.ld', 'app.nwa', '-o', '1.o'],
      { 'module.ld': k.script.module, 'app.nwa': bytes }, '1.o');
    const o2 = await objcopy(['--keep-global-symbol=main', '--redefine-sym', 'eadk_keyboard_scan=np_keyboard_scan',
      '--redefine-sym', 'eadk_event_get=np_event_get', '--redefine-sym', 'eadk_display_draw_string=np_display_draw_string',
      '--redefine-sym', '_heap_start=np_' + id + '_heap', '--redefine-sym', '_sbrk=np_sbrk', '1.o', '2.o'], { '1.o': o1 }, '2.o');
    const m = A.npmodule(o2, id, index);
    const missing = m.undefined.filter((u) => u !== 'np_' + id + '_heap' && !PROVIDED.test(u));
    if (missing.length) throw new InstallerError('numplay.missing', { file: fileName, symbol: missing[0] }, fileName + ' needs ' + missing[0] + ', which NumPlay doesn\'t have');
    if (((m.data + 7) & ~7) + m.bss + k.launcherRam > k.ramLimit) throw new InstallerError('numplay.ram', { file: fileName }, fileName + ' needs more RAM than NumPlay can give it');
    const c = A.colors(info.icon), cd = A.card(info.icon, c.bottom);
    const z = new Uint8Array(await new Response(new Blob([cd.indices]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const ascii = (t) => (t || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 24);
    // (named after its file: "FNAF Speed.nwa" stays apart from NumPlay's own FNAF)
    const title = ascii(fileName.replace(/\.nwa$/i, '')) || ascii(info.name) || 'App';
    const entry = A.entryObject({ id, index, title, tagline: ascii(fileName), ...c, data: m.data, bss: m.bss, palette: cd.palette, z });
    const alloc = (obj) => A.readElf(obj).secs.reduce((n, s) => n + (s.flags & 2 && s.type !== 8 ? align4(s.size) : 0), 0);
    return { id, index, title, file: fileName, obj: m.obj, entry, data: m.data, bss: m.bss, color: c.top,
      icon: info.icon ? iconDataUrl(info.icon, A) : null, flash: alloc(m.obj) + alloc(entry) + 8 };
  }

  // ---------------------------------------------------------------- linking a NumPlay
  // ids: NumPlay games in the order the launcher shows them; extras: apps from extraFrom; roms: from romFrom, played
  // by Retro-Go; carts: from cartFrom, played by NumPico. -> { bytes, name }: a NumPlay, or Retro-Go on its own when
  // there's a Mega Drive game
  async build({ ids, extras = [], roms = [], carts = [], lang = 'en', variant = 'NumPlay', name = 'NumPlay', matrices = false, hint = true, secret = 0 }) {
    if (retroGoAlone(roms)) return { bytes: await this.buildRetroGo(roms), name: 'RetroGo' };
    ids = ids.concat(roms.length ? [this.retroGo.id] : [], carts.length ? [this.numPico.id] : []);
    if (ids.length + extras.length > MAX_GAMES) throw new InstallerError('numplay.maxGames', { max: MAX_GAMES }, 'NumPlay holds ' + MAX_GAMES + ' games and apps at most');
    if (carts.length > MAX_CARTS) throw new InstallerError('numplay.maxCarts', { max: MAX_CARTS }, 'NumPico holds ' + MAX_CARTS + ' carts at most');
    if (!ids.length && !extras.length) throw new InstallerError('numplay.pickFirst', {}, 'Pick some games first');
    const k = lang === 'en' ? this.en : await this.language(lang);
    const dir = lang === 'en' ? '' : lang + '/';
    // a game's object in the chosen language, or the English one when that language has none of its own
    const objPath = (id) => (lang !== 'en' && k.byId[id] && !k.byId[id].en ? dir : '') + 'games/' + id + '.o.gz';
    const [base, arena, icon, ...objs] = await Promise.all([fetchBytes(KIT + dir + 'base.o.gz'), fetchBytes(KIT + dir + 'arena.o.gz'),
      fetchBytes(KIT + 'variants/' + variant + '-icon.o.gz'), ...ids.map((id) => fetchBytes(KIT + objPath(id)))]);
    const files = { 'base.o': base, 'arena.o': arena, 'app.o': settingsObject({ name, matrices, hint, secret }), 'icon.o': icon };
    const args = k.link.concat(['-T', 'numplay.ld', 'base.o', 'arena.o', 'app.o', 'icon.o']);
    ids.forEach((id, i) => { files[id + '.o'] = objs[i]; args.push(id + '.o'); });
    for (const a of extras) {
      files[a.id + '.o'] = a.obj;
      files[a.id + '-entry.o'] = a.entry;
      args.push(a.id + '.o', a.id + '-entry.o');
    }
    // the tables of your games, which the kit's script puts in Retro-Go's and NumPico's blocks
    if (roms.length) {
      files['roms.o'] = romObject(roms);
      args.push('roms.o');
    }
    if (carts.length) {
      files['carts.o'] = elfObject([{ section: '.rodata.np_carts', symbol: 'np_carts', data: (await loadPicoJs()).cartTable(carts), align: 4 }]);
      args.push('carts.o');
    }
    const index = (id) => (k.byId[id] || this.en.byId[id]).index;
    const script = k.script.blocks ? k.script : this.en.script;
    // the launcher lists games in the order of their entries: yours
    const order = ids.map((id) => 'KEEP(*(.rodata.np_games.' + String(index(id)).padStart(2, '0') + '))')
      .concat(extras.map((a) => 'KEEP(*(.rodata.np_games.' + a.id + '))')).join('\n    ');
    const head = script.head.replace('KEEP(*(SORT_BY_NAME(.rodata.np_games.*)))', order);
    // the games' code in the kit's order: NumPlay's own games, then the apps, then the big games (which may run on
    // past the app area with Nwagra); each app's RAM starts at the arena, as a game's does
    const sorted = ids.slice().sort((a, b) => index(a) - index(b));
    const firstBig = sorted.findIndex((id) => this.en.byId[id].xl);
    const blocks = sorted.map((id) => script.blocks[id] || this.en.script.blocks[id]);
    blocks.splice(firstBig < 0 ? blocks.length : firstBig, 0,
      ...extras.map((a) => this.en.script.app.replace(/@ID@/g, a.id).replace(/@N@/g, a.index)));
    const ram = extras.map((a) => {
      const bss = (a.data + 7) & ~7, heap = (bss + a.bss + 7) & ~7;
      return `    np_${a.id}_data = np_arena;\n    np_${a.id}_bss = np_arena + ${bss};\n    np_${a.id}_heap = np_arena + ${heap};\n`;
    }).join('');
    const tail = script.tail.replace('*(.np_arena) }', '*(.np_arena)\n' + ram + '  }');
    if (ram && tail === script.tail) throw new InstallerError('numplay.noArena', {}, 'This NumPlay kit has no arena for apps');
    files['numplay.ld'] = head + blocks.join('') + tail;
    const linked = await ld(args.concat(['-o', 'out.nwa']), files, 'out.nwa');
    return { bytes: await objcopy(['--strip-unneeded', 'in.nwa', 'out.nwa'], { 'in.nwa': linked }, 'out.nwa'), name };
  }

  // Retro-Go as an app of its own with its table of games, linked as NumPlay's games/retrogo Makefile links RetroGo.nwa
  async buildRetroGo(roms) {
    const app = await fetchBytes(KIT + 'apps/RetroGo-app.o.gz');
    const linked = await ld(['-r', '-T', 'roms.ld', 'app.o', 'roms.o', '-o', 'out.nwa'], { 'app.o': app, 'roms.o': romObject(roms),
      'roms.ld': 'SECTIONS {\n  .rodata.np_roms : { KEEP(*(.rodata.np_roms)) np_retrogo_end = .; }\n}\n' }, 'out.nwa');
    return objcopy(['--strip-unneeded', 'in.nwa', 'out.nwa'], { 'in.nwa': linked }, 'out.nwa');
  }

  // a big game that only fits as an app of its own: NumPlay's ready-made .nwa of it
  standalone(id) {
    const g = this.en.byId[id];
    return g && g.alone ? fetchBytes(KIT + 'apps/' + id + '.nwa.gz').then((bytes) => ({ bytes, file: g.alone.file })) : null;
  }
}

// with a Mega Drive game, Retro-Go goes on its own: inside NumPlay, the RAM those games need isn't there
const retroGoAlone = (roms) => roms.some((r) => r.sys === MEGA_DRIVE);
const romObject = (roms) => elfObject([{ section: '.rodata.np_roms', symbol: 'np_roms', data: romTable(roms), align: 4 }]);

// an app's icon (RGB565 pixels) as an image URL
function iconDataUrl(icon, A) {
  const c = document.createElement('canvas');
  c.width = A.ICON_W; c.height = A.ICON_H;
  const g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
  icon.forEach((v, p) => img.data.set([(v >> 11) * 255 / 31, (v >> 5 & 63) * 255 / 63, (v & 31) * 255 / 31, 255], 4 * p));
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
