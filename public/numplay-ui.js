// SPDX-License-Identifier: GPL-3.0-or-later
// The NumPlay builder in the installer page: pick games (and the extra apps the server offers, as games like the
// others), add your own Game Boy, NES and Sega games for Retro-Go and PICO-8 carts for NumPico, choose the launcher's
// looks, and its NumPlay.nwa goes straight into the apps to install.
import { NumPlayKit, VARIANTS, SECRETS, MAX_GAMES, MAX_CARTS } from './lib/numplay.js';
import { SYSTEMS, MEGA_DRIVE, extensions } from './lib/roms.js';
import { mb } from './lib/install.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const size = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : mb(n));
const LANG_NAMES = { en: 'English', fr: 'Français', zh: '中文' };

export function initNumPlay({ log, free, add }) {
  const st = { kit: null, loading: null, picked: [], extras: [], roms: [], carts: [], lang: 'en', variant: 'NumPlay', busy: false };
  const tiles = new Map();  // id -> its button

  $('#np-open').addEventListener('click', async () => {
    const open = $('#np').hidden;
    $('#np').hidden = !open;
    $('#np-open').setAttribute('aria-expanded', String(open));
    if (open) await load();
  });

  async function load() {
    if (st.kit) return render();
    st.loading = st.loading || (async () => {
      status('Getting NumPlay\'s games…');
      st.kit = await NumPlayKit.load();
      const langs = $('#np-lang');
      for (const l of st.kit.languages) langs.append(new Option(LANG_NAMES[l] || l, l));
      for (const [v] of Object.entries(VARIANTS)) {
        const b = el('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.title = v.replace('NumPlay-', '');
        const img = el('img');
        img.src = st.kit.variantUrl(v);
        img.alt = b.title;
        b.append(img);
        b.addEventListener('click', () => pickVariant(v));
        $('#np-variants').append(b);
      }
      SECRETS.forEach((s, i) => $('#np-secret').append(new Option(s, String(i))));
      for (const g of st.kit.games()) tiles.set(g.id, tile(g.id, g.title, st.kit.iconUrl(g.id), g.flash, g.xl ? 'big' : '', g.top, g.credit));
      ownGames();
      log(`NumPlay ${st.kit.version}: ${st.kit.games().length} games`);
      status('');
      render();
      await loadExtras();
    })().catch((e) => { st.loading = null; status('Couldn\'t get NumPlay\'s games: ' + e.message + '. Try again.'); throw e; });
    return st.loading;
  }

  // the server's extra apps (extra/*.nwa), as games of NumPlay like the others
  async function loadExtras() {
    const names = await fetch('/numplay/extra/').then((r) => r.json()).catch(() => []);
    for (const [i, name] of names.entries()) {
      try {
        const bytes = new Uint8Array(await fetch('/numplay/extra/' + encodeURIComponent(name)).then((r) => r.arrayBuffer()));
        const a = await st.kit.extraFrom(bytes, name, i + 1);
        st.extras.push(a);
        tiles.set(a.id, tile(a.id, a.title, a.icon, a.flash, 'extra', a.color, 'From extra/' + a.file));
        render();
      } catch (e) {
        log(name + ': ' + e.message);
      }
    }
  }

  // ---------------------------------------------------------------- your own games: Retro-Go's ROMs, NumPico's carts
  function ownGames() {
    const rg = st.kit.retroGo, pk = st.kit.numPico;
    if (rg) {
      const names = st.kit.romSystems.map((s) => SYSTEMS[s].name);
      const all = names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
      $('#np-roms-what').textContent = rg.tagline ? 'Your ' + rg.tagline : 'Your ' + all + ' games';
      $('#np-rom-file').accept = extensions(st.kit.romSystems).join(',');
      $('#np-roms').title = [rg.title + ': ' + all, rg.credit].filter(Boolean).join('\n');
      $('#np-roms').hidden = false;
      dropOn($('#np-roms'), addRoms);
      $('#np-rom-file').addEventListener('change', (e) => { addRoms([...e.target.files]); e.target.value = ''; });
    }
    if (pk) {
      $('#np-carts').title = [pk.title, pk.credit].filter(Boolean).join('\n');
      $('#np-carts').hidden = false;
      dropOn($('#np-carts'), addCarts);
      $('#np-cart-file').addEventListener('change', (e) => { addCarts([...e.target.files]); e.target.value = ''; });
    }
  }
  function dropOn(box, add) {
    box.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); box.classList.remove('over'); add([...e.dataTransfer.files]); });
  }

  async function addRoms(files) {
    for (const f of files) {
      try {
        const r = st.kit.romFrom(new Uint8Array(await f.arrayBuffer()), f.name);
        if (r.sys === MEGA_DRIVE && !st.roms.some((x) => x.sys === MEGA_DRIVE))
          status('With a Mega Drive game, you get Retro-Go on its own with your games: they need all of NumPlay\'s RAM.');
        st.roms.push(r);
      } catch (e) { status(f.name + ': ' + e.message); }
    }
    render();
  }
  async function addCarts(files) {
    for (const f of files) {
      if (st.carts.length >= MAX_CARTS) { status('NumPico holds ' + MAX_CARTS + ' carts at most'); break; }
      try {
        const c = await st.kit.cartFrom(new Uint8Array(await f.arrayBuffer()), f.name);
        c.url = labelUrl(await st.kit.cartLabel(c));
        st.carts.push(c);
      } catch (e) { status(e.message); }
    }
    render();
  }
  function labelUrl(rgba) {
    if (!rgba) return null;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    c.getContext('2d').putImageData(new ImageData(rgba, 128, 128), 0, 0);
    return c.toDataURL('image/png');
  }
  // a game you added, as a chip: its picture or system, name, size, and a button to take it out
  function chip(item, label, tag, picture, list) {
    const li = el('li');
    li.title = label;
    if (picture) { const img = el('img'); img.src = picture; img.alt = ''; li.append(img); }
    if (tag) li.append(el('span', 'tag', tag));
    const x = el('button', '', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Take out ' + label);
    x.addEventListener('click', () => { list.splice(list.indexOf(item), 1); render(); });
    li.append(el('span', '', label), el('span', 's', size(item.flash)), x);
    return li;
  }

  // a game's button: its icon, name and size; its credit (from NumPlay's kit) when you hover it
  function tile(id, title, icon, flash, tag, color, credit) {
    const b = el('button', 'tile');
    b.type = 'button';
    b.dataset.id = id;
    b.setAttribute('aria-pressed', 'false');
    if (icon) { const img = el('img'); img.src = icon; img.alt = ''; img.loading = 'lazy'; b.append(img); }
    else { const ph = el('span', 'ph', title.slice(0, 1)); ph.style.background = '#' + String(color || '0x888888').replace(/^0x/i, '').padStart(6, '0'); b.append(ph); }
    b.append(el('span', 't', title), el('span', 's', size(flash)));
    b.title = [title, credit, tag === 'big' ? 'A big game: it may need Nwagra\'s space' : ''].filter(Boolean).join('\n');
    b.addEventListener('click', () => toggle(id));
    return b;
  }

  function toggle(id) {
    const i = st.picked.indexOf(id);
    if (i >= 0) st.picked.splice(i, 1);
    else if (st.picked.length >= MAX_GAMES) return status('NumPlay holds ' + MAX_GAMES + ' games at most');
    else st.picked.push(id);
    render();
  }

  function pickVariant(v) {
    st.variant = v;
    $('#np-name').value = VARIANTS[v];
    if (v === 'NumPlay-Matrices') $('#np-opens').value = 'matrices';
    render();
  }

  // the games picked, as the kit and the extras have them
  const pickedGames = () => st.picked.filter((id) => !id.startsWith('app'));
  const pickedExtras = () => st.picked.map((id) => st.extras.find((a) => a.id === id)).filter(Boolean);
  const meta = (id) => st.kit.game(id, st.lang) || st.extras.find((a) => a.id === id);
  const flashOf = (id) => (meta(id) || {}).flash || 0;

  function visibleOrder() {
    const q = $('#np-search').value.trim().toLowerCase();
    const all = [...tiles.keys()].filter((id) => !q || (meta(id).title || '').toLowerCase().includes(q));
    const by = $('#np-sort').value;
    const rank = (id) => (meta(id).rank ?? 1e6);
    return all.sort(by === 'name' ? (a, b) => meta(a).title.localeCompare(meta(b).title)
      : by === 'small' ? (a, b) => flashOf(a) - flashOf(b)
      : by === 'big' ? (a, b) => flashOf(b) - flashOf(a)
      : (a, b) => rank(a) - rank(b));
  }

  function render() {
    if (!st.kit) return;
    const grid = $('#np-grid');
    grid.replaceChildren(...visibleOrder().map((id) => tiles.get(id)));
    for (const [id, b] of tiles) b.setAttribute('aria-pressed', String(st.picked.includes(id)));
    for (const b of $('#np-variants').children) b.setAttribute('aria-checked', String(b.title === st.variant.replace('NumPlay-', '')));
    $('#np-secret-row').hidden = $('#np-opens').value !== 'matrices';

    $('#np-rom-list').replaceChildren(...st.roms.map((r) => chip(r, r.name, SYSTEMS[r.sys].tag, null, st.roms)));
    $('#np-cart-list').replaceChildren(...st.carts.map((c) => chip(c, c.title, c.url ? '' : 'P8', c.url, st.carts)));

    const n = st.picked.length + st.roms.length + st.carts.length, room = free();
    const total = st.kit.estimate({ ids: pickedGames(), extras: pickedExtras(), roms: st.roms, carts: st.carts, lang: st.lang });
    const over = room != null && total > room, alone = st.roms.some((r) => r.sys === MEGA_DRIVE);
    $('#np-plan').textContent = !n ? 'No games picked yet.'
      : (alone ? `Retro-Go with ${st.roms.length} game${st.roms.length > 1 ? 's' : ''}` : `${n} game${n > 1 ? 's' : ''}`) + `, about ${size(total)}`
        + (room == null ? '' : over ? `: ${size(total - room)} more than the space left (${size(Math.max(0, room))}). Turn on Nwagra, or take games out.` : ` of the ${size(room)} free.`);
    $('#np-plan').classList.toggle('warn', over);
    $('#np-add').disabled = st.busy || !n || over;
  }

  function status(t) { $('#np-status').textContent = t; $('#np-status').hidden = !t; }

  ['#np-search', '#np-sort'].forEach((s) => $(s).addEventListener('input', render));
  $('#np-opens').addEventListener('change', render);
  $('#np-lang').addEventListener('change', async (e) => {
    st.lang = e.target.value;
    try { await st.kit.language(st.lang); } catch (err) { status('That language didn\'t load: ' + err.message); }
    render();
  });
  // the install options change the space left
  ['#keep', '#nwagra'].forEach((s) => $(s).addEventListener('change', render));

  $('#np-add').addEventListener('click', async () => {
    st.busy = true;
    render();
    const name = $('#np-name').value.trim() || 'NumPlay';
    try {
      status('Linking your NumPlay…');
      const out = await st.kit.build({ ids: pickedGames(), extras: pickedExtras(), roms: st.roms, carts: st.carts, lang: st.lang,
        variant: st.variant, name, matrices: $('#np-opens').value === 'matrices', hint: $('#np-hint').checked, secret: +$('#np-secret').value });
      await add(out.bytes, out.name.replace(/[^\w.-]+/g, '') || 'NumPlay');
      const n = st.picked.length + st.roms.length + st.carts.length;
      log(`Made ${out.name} with ${n} game(s): it's in the apps to install`);
      status(`${out.name} is in the apps to install, below.`);
    } catch (e) {
      status('Couldn\'t make it: ' + e.message);
      log('NumPlay: ' + e.message);
    } finally {
      st.busy = false;
      render();
    }
  });

  return { render };
}
