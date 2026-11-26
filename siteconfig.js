// SPDX-License-Identifier: GPL-3.0-or-later
// The optional site config, config.json next to server.js (see config.example.json and the README): a custom font for
// the page. Read once at start; anything wrong or missing is ignored (the page keeps its default font). Nothing from it
// is trusted as it is: the stylesheet must be an https URL, the font family only plain font-name characters, and the
// origins it names are the only ones the Content-Security-Policy opens up (style-src, font-src).
'use strict';
const fs = require('fs');

const FAMILY = /^[A-Za-z0-9 ,'"_-]{1,200}$/;

// an https origin ("https://fonts.gstatic.com") from a URL string, or null: no credentials, no other scheme
function originOf(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

// raw config object -> { fontStylesheet, fontFamily, styleOrigins, fontOrigins } (all safe, empty when absent)
function sanitize(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const sheetOrigin = typeof c.fontStylesheet === 'string' ? originOf(c.fontStylesheet) : null;
  const fontStylesheet = sheetOrigin ? new URL(c.fontStylesheet).href : '';
  const fontFamily = typeof c.fontFamily === 'string' && FAMILY.test(c.fontFamily.trim()) ? c.fontFamily.trim() : '';
  const extra = (Array.isArray(c.fontOrigins) ? c.fontOrigins : []).map(originOf).filter(Boolean);
  return { fontStylesheet, fontFamily, styleOrigins: sheetOrigin ? [sheetOrigin] : [],
    fontOrigins: [...new Set([...(sheetOrigin ? [sheetOrigin] : []), ...extra])] };
}

function load(file) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return sanitize(null); }
}

// the Content-Security-Policy, with the config's origins opened for stylesheets and fonts only
function csp(site) {
  return ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", ['style-src', "'self'", ...site.styleOrigins].join(' '),
    "img-src 'self' blob: data:", ['font-src', "'self'", ...site.fontOrigins].join(' '),
    "connect-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
}

module.exports = { sanitize, load, csp };
