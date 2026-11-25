// SPDX-License-Identifier: GPL-3.0-or-later
// Gets Nwa Toolkit ready (npm run setup):
//  - public/vendor/eadk.o: the small object every .nwa is linked with (its EADK calls jump through the calculator
//    software's trampoline table). It's NumWorks' and isn't in the repository: it comes from the nwlink npm package
//    they publish (npm install). public/vendor/ld.* and objcopy.* (GNU binutils, GPL) are in the repository.
//  - extra/: .nwa apps the NumPlay builder offers as games of their own. Put yours there.
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'public', 'vendor', 'eadk.o');

const candidates = [
  path.join(REPO, 'node_modules', 'nwlink', 'dist', 'index.js'),
  path.join(REPO, '..', 'numworks', 'node_modules', 'nwlink', 'dist', 'index.js'),
];
const nwlink = candidates.find((p) => fs.existsSync(p));
if (!nwlink) {
  console.error('nwlink not found: run `npm install` first.');
  process.exit(1);
}
// eadk.o is bundled as {type:"Buffer",data:[...]}: the only object file (ELF magic 127,69,76,70) in the bundle
const m = /exports=\{type:"Buffer",data:\[(127,69,76,70,[0-9,]+)\]\}/.exec(fs.readFileSync(nwlink, 'utf8'));
if (!m) throw new Error('eadk.o not found in ' + nwlink);
const eadk = Buffer.from(m[1].split(',').map(Number));
fs.writeFileSync(OUT, eadk);
console.log('wrote public/vendor/eadk.o (%d bytes)', eadk.length);

fs.mkdirSync(path.join(REPO, 'extra'), { recursive: true });
