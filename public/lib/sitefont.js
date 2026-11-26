// SPDX-License-Identifier: GPL-3.0-or-later
// The custom font from the server's config.json (siteconfig.js, served at /site-config.json): a stylesheet link and the
// font-family the page uses. Empty or failing: the page keeps its default font. Nothing is evaluated: a <link> and a CSS
// custom property set through the CSSOM (which the Content-Security-Policy allows).
const FAMILY = /^[A-Za-z0-9 ,'"_-]{1,200}$/;

export function applySiteFont(doc, cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  let done = false;
  if (typeof cfg.fontStylesheet === 'string' && /^https:\/\/[^\s"'<>]+$/.test(cfg.fontStylesheet)) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = cfg.fontStylesheet;
    doc.head.append(link);
    done = true;
  }
  if (typeof cfg.fontFamily === 'string' && FAMILY.test(cfg.fontFamily.trim())) {
    doc.documentElement.style.setProperty('--font-custom', cfg.fontFamily.trim());
    done = true;
  }
  return done;
}

export async function loadSiteFont(doc = document) {
  try {
    const r = await fetch('site-config.json');
    if (r.ok) applySiteFont(doc, await r.json());
  } catch { /* no config: the default font */ }
}
