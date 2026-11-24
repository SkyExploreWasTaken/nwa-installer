// Added to NumPlay Studio's page when the installer's server shows it at /numplay/ (see numplay.js):
//  - a bar to go back to the installer
//  - the extra apps next to server.js (extra/*.nwa) offered as games of their own, in "Your own apps"
//  - every .nwa the page makes is also handed to the installer: "Install on the calculator" opens it there
(() => {
  'use strict';
  const HANDOFF_DB = 'nwa-installer', HANDOFF_STORE = 'handoff';

  // ------------------------------------------------------------------ the bar
  const bar = document.createElement('div');
  bar.id = 'nwa-bridge';
  bar.innerHTML = '<a href="/" class="nb-back">&larr; NWA Installer</a><span class="nb-msg"></span>'
    + '<span class="nb-extra"></span><a class="nb-install" href="/?numplay" hidden>Install on the calculator &rarr;</a>';
  const css = document.createElement('style');
  css.textContent = `
    #nwa-bridge { position: sticky; top: 0; z-index: 1000; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
      padding: 8px 16px; font: 600 14px/1.4 system-ui, "Segoe UI", sans-serif; color: #fff;
      background: linear-gradient(90deg, #d65f26, #e8743b); box-shadow: 0 2px 10px rgba(0,0,0,.2); }
    #nwa-bridge a { color: #fff; text-decoration: none; }
    #nwa-bridge .nb-msg { flex: 1; font-weight: 500; opacity: .95; }
    #nwa-bridge button, #nwa-bridge .nb-install { font: inherit; color: #d65f26; background: #fff; border: 0; border-radius: 8px;
      padding: 5px 12px; cursor: pointer; }
    #nwa-bridge button:disabled { opacity: .6; cursor: default; }`;
  document.head.appendChild(css);
  document.body.prepend(bar);
  const msg = (t) => { bar.querySelector('.nb-msg').textContent = t; };
  msg('Pick games, then make your NumPlay.nwa. It goes straight to the installer too.');

  // ------------------------------------------------------------------ extra apps (our FNAF)
  // Studio takes apps through its "Your own apps" file input: give it the file the same way a person would
  async function addExtra(name, button) {
    const input = document.getElementById('app-file');
    const shelf = document.getElementById('app-carts');
    if (!input || !shelf) return false;
    const bytes = await fetch('/numplay-extra/' + encodeURIComponent(name)).then((r) => r.arrayBuffer());
    const before = shelf.children.length;
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // it's in when its card shows up among "Your apps"
    for (let t = 0; t < 40; t++) {
      await new Promise((ok) => setTimeout(ok, 250));
      if (shelf.children.length > before) {
        if (button) { button.textContent = name.replace(/\.nwa$/i, '') + ' added'; button.disabled = true; }
        return true;
      }
    }
    return false;
  }

  async function offerExtras() {
    const list = await fetch('/numplay-extra/list.json').then((r) => r.json()).catch(() => []);
    const box = bar.querySelector('.nb-extra');
    for (const name of list) {
      const b = document.createElement('button');
      b.textContent = 'Add ' + name.replace(/\.nwa$/i, '');
      b.title = 'Adds ' + name + ' to this NumPlay as a game of its own';
      b.addEventListener('click', async () => {
        b.disabled = true;
        if (!await addExtra(name, b)) { b.disabled = false; msg(name + " didn't fit. Pick a bigger space for apps (Epsilon 26 or Nwagra, by the size gauge) or take games out, then add it again."); }
      });
      box.appendChild(b);
    }
    // add them once Studio is ready: it shows its page (drops the intro-wait class) when its kit has loaded
    for (let t = 0; t < 120 && document.documentElement.classList.contains('intro-wait'); t++) {
      await new Promise((ok) => setTimeout(ok, 250));
    }
    await new Promise((ok) => setTimeout(ok, 500));
    for (const b of box.querySelectorAll('button')) if (!b.disabled) b.click();
  }
  offerExtras();

  // ------------------------------------------------------------------ hand-off to the installer
  function save(record) {
    return new Promise((ok, no) => {
      const open = indexedDB.open(HANDOFF_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(HANDOFF_STORE);
      open.onerror = () => no(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(HANDOFF_STORE, 'readwrite');
        tx.objectStore(HANDOFF_STORE).put(record, 'latest');
        tx.oncomplete = () => { open.result.close(); ok(); };
        tx.onerror = () => no(tx.error);
      };
    });
  }
  // Studio saves what it makes with a download link: keep a copy of each .nwa for the installer
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && /\.nwa$/i.test(this.download) && this.href.startsWith('blob:')) {
      const name = this.download;
      fetch(this.href).then((r) => r.arrayBuffer()).then((bytes) => save({ name, bytes, at: Date.now() })).then(() => {
        bar.querySelector('.nb-install').hidden = false;
        msg(name + ' is ready. It was downloaded, and the installer has it too.');
      }).catch((e) => msg('Could not hand ' + name + ' to the installer: ' + e.message));
    }
    return click.call(this);
  };
})();
