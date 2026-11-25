// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the page's dictionaries (public/i18n/*.js) against English, the source of truth:
//  - every language has exactly en.js's keys (none missing, none extra)
//  - each text has the same {placeholders} (with their :format) and the same [b]/[code]/[aN] markup as in English
//  - plurals stay plurals (an object with at least 'other'), plain texts stay plain
//  - every literal key the page's code asks for (t('...'), T('...'), data-i18n*="...") is in en.js
//   node tools/check-i18n.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(repo, 'public', 'i18n');
const load = async (f) => (await import(pathToFileURL(path.join(dir, f)).href)).default;
const en = await load('en.js');
const problems = [];

const texts = (v) => (typeof v === 'object' ? Object.values(v) : [v]);
const marks = (v) => [...new Set(texts(v).flatMap((s) => [...s.matchAll(/\{\w+(?::\w+)?\}|\[\/?(?:b|code|a\d)\]/g)].map((m) => m[0])))].sort().join(' ');

for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js' && f !== 'en.js')) {
  const d = await load(f);
  for (const k of Object.keys(en)) {
    if (!(k in d)) { problems.push(`${f}: missing ${k}`); continue; }
    const a = en[k], b = d[k];
    if ((typeof a === 'object') !== (typeof b === 'object')) problems.push(`${f}: ${k} should be ${typeof a === 'object' ? 'a plural object' : 'a plain text'}`);
    else if (typeof b === 'object' && !('other' in b)) problems.push(`${f}: ${k} plural has no 'other'`);
    if (marks(a) !== marks(b)) problems.push(`${f}: ${k} has ${marks(b) || 'no placeholders'}, English has ${marks(a) || 'none'}`);
  }
  for (const k of Object.keys(d)) if (!(k in en)) problems.push(`${f}: extra key ${k}`);
}

// the keys the page's code names literally
const used = new Set();
const scan = (file, re) => { for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) used.add(m[1]); };
for (const f of ['app.js', 'numplay-ui.js']) scan(path.join(repo, 'public', f), /\b[tT]\(\s*'([\w.]*\w)'/g);
scan(path.join(repo, 'public', 'index.html'), /data-i18n(?:-[\w-]+)?="([\w.]+)"/g);
for (const k of used) if (!(k in en)) problems.push(`en.js: missing ${k} (used by the page)`);

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`i18n: ${Object.keys(en).length} keys, all languages match English; ${used.size} literal keys used by the page all exist`);
