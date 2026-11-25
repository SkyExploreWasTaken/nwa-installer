// SPDX-License-Identifier: GPL-3.0-or-later
// The page's languages. Each dictionary (en.js, fr.js, ...) is a flat { 'screen.key': 'text' } object; English is the
// source of truth and the fallback. To add a language: a new dictionary next to this file, one line in DICTS, and one
// <option> in index.html's #lang. See README, "Adding a language".
//
//   t('plan.writes', { size: 465 * 1024, from: '0x90200000' })
//   - {name} is replaced by vars.name. Numbers are formatted for the language (1 234,5 in French), arrays become a
//     list ("A, B and C" / "A, B et C").
//   - {name:size} formats a byte count as KB or MB with the language's units (465 KB, 1,38 Mo); {name:mb} always in MB.
//   - a key whose text is { one: '...', other: '...' } is a plural, picked by vars.count with Intl.PluralRules (French
//     treats 0 and 1 as singular: let Intl decide).
//   - a missing key shows as the key itself, so it's visible, never blank.
import en from './en.js';
import fr from './fr.js';

const DICTS = { en, fr };
export const LANGS = Object.keys(DICTS);
const STORE = 'nwa.lang';

let lang = startLang();

function startLang() {
  try { const s = localStorage.getItem(STORE); if (s && DICTS[s]) return s; } catch { /* no storage */ }
  const nav = (globalThis.navigator?.language || '').toLowerCase();
  return LANGS.find((l) => l !== 'en' && nav.startsWith(l)) || 'en';
}

export const getLang = () => lang;
export const has = (key) => key in DICTS[lang] || key in en;

const nf = (opts) => new Intl.NumberFormat(lang, opts);
export const mb = (n) => nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n / 1048576) + ' ' + t('unit.mb');
// KB under 1 MB (at least 1 KB unless it's nothing), else MB
export const size = (n) => (n < 1048576 ? nf().format(Math.max(n > 0 ? 1 : 0, Math.round(n / 1024))) + ' ' + t('unit.kb') : mb(n));

function format(v, how) {
  if (how === 'size') return size(v);
  if (how === 'mb') return mb(v);
  if (Array.isArray(v)) return new Intl.ListFormat(lang, { type: 'conjunction' }).format(v.map(String));
  if (typeof v === 'number') return nf().format(v);
  return String(v);
}

export function t(key, vars = {}) {
  let s = DICTS[lang][key] ?? en[key];
  if (s == null) return key;
  if (typeof s === 'object') s = s[new Intl.PluralRules(lang).select(vars.count ?? 0)] ?? s.other;
  return s.replace(/\{(\w+)(?::(\w+))?\}/g, (m, k, how) => (k in vars ? format(vars[k], how) : m));
}

// an error's text in the page's language: lib and server errors carry a code (err.<code> in the dictionaries) and
// params; anything else (a browser's DOMException, a bug) shows its own message.
// A params.msg left out is filled from the error's cause, so wrapped errors read as one sentence.
export function errText(e) {
  if (e == null) return '';
  if (typeof e.code === 'string' && has('err.' + e.code)) {
    const params = { ...e.params };
    if (!('msg' in params)) params.msg = e.cause ? errText(e.cause) : '';
    return t('err.' + e.code, params);
  }
  return t('err.unknown', { msg: e.message ?? e.error ?? String(e) });
}

// [b]bold[/b], [code]x[/code], [a0]first link[/a0], [a1]... in a text, as DOM nodes: the links keep the href of the
// element's own <a>s, in order. No innerHTML: translations are only ever text.
function rich(node, text) {
  node._i18nLinks = node._i18nLinks || [...node.querySelectorAll('a')].map((a) => a.cloneNode(false));
  const out = [];
  const re = /\[(b|code|a(\d))\]([\s\S]*?)\[\/\1\]/g;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(document.createTextNode(text.slice(at, m.index)));
    const e = m[2] != null ? (node._i18nLinks[+m[2]] || document.createElement('a')).cloneNode(false) : document.createElement(m[1]);
    e.textContent = m[3];
    out.push(e);
    at = re.lastIndex;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  node.replaceChildren(...out);
}

// fills the page's [data-i18n] (text), [data-i18n-rich] (text with [b]/[code]/[aN]), [data-i18n-title],
// [data-i18n-placeholder] and [data-i18n-aria-label]; sets <html lang> and the title
export function applyDom(root = document) {
  for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll('[data-i18n-rich]')) rich(e, t(e.dataset.i18nRich));
  for (const e of root.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of root.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
  for (const e of root.querySelectorAll('[data-i18n-aria-label]')) e.setAttribute('aria-label', t(e.dataset.i18nAriaLabel));
  if (root === document) {
    document.documentElement.lang = lang;
    document.title = t('app.title');
  }
}

// switch language: kept for next time, the page's static text redone, and 'langchange' for the parts drawn by JS
export function setLang(l) {
  if (!DICTS[l]) return;
  lang = l;
  try { localStorage.setItem(STORE, l); } catch { /* no storage */ }
  applyDom();
  window.dispatchEvent(new Event('langchange'));
}

// the header's language <select>
export function initLangSelect(sel) {
  sel.value = lang;
  sel.addEventListener('change', () => setLang(sel.value));
}
