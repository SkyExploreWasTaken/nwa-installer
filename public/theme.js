// SPDX-License-Identifier: GPL-3.0-or-later
// The theme: Catppuccin Latte or Mocha (style.css). Auto, the default, follows the system (prefers-color-scheme); the
// picker's choice overrides it and is kept in localStorage['nwa.theme'] ('latte' | 'mocha'); Auto removes it. A plain
// script in <head>, so the theme is set before the page is first drawn (no flash of the other one).
(function () {
  var KEY = 'nwa.theme', THEMES = ['latte', 'mocha'];
  function saved() {
    try { var v = localStorage.getItem(KEY); return THEMES.indexOf(v) >= 0 ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function apply(v) {
    if (THEMES.indexOf(v) >= 0) document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
  }
  function choose(v) {
    v = THEMES.indexOf(v) >= 0 ? v : 'auto';
    try { if (v === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* private mode: this visit only */ }
    apply(v);
  }
  apply(saved());
  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('theme');
    if (!sel) return;
    sel.value = saved();
    sel.addEventListener('change', function () { choose(sel.value); });
  });
})();
