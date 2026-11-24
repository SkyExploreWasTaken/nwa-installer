// Puts eadk.o in vendor/: the small object every .nwa is linked with (its EADK calls jump through the calculator
// software's trampoline table). It's NumWorks' and isn't in this repository: it's taken from the nwlink npm package
// (npm install), the command-line tool NumWorks publishes. vendor/ld.* and vendor/objcopy.* (GNU binutils,
// GPL) are in the repository already.
//   npm install && npm run setup
'use strict';
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'vendor', 'eadk.o');

const candidates = [
  path.join(__dirname, 'node_modules', 'nwlink', 'dist', 'index.js'),
  path.join(__dirname, '..', 'numworks', 'node_modules', 'nwlink', 'dist', 'index.js'),
];
const nwlink = candidates.find((p) => fs.existsSync(p));
if (!nwlink) {
  console.error('nwlink not found. Run `npm install` here first.');
  process.exit(1);
}
const src = fs.readFileSync(nwlink, 'utf8');
// eadk.o is bundled as {type:"Buffer",data:[...]}: the only object file (ELF magic 127,69,76,70) in the bundle
const m = /exports=\{type:"Buffer",data:\[(127,69,76,70,[0-9,]+)\]\}/.exec(src);
if (!m) throw new Error('eadk.o not found in ' + nwlink);
const eadk = Buffer.from(m[1].split(',').map(Number));
fs.writeFileSync(OUT, eadk);
console.log('wrote vendor/eadk.o (%d bytes) from %s', eadk.length, path.relative(__dirname, nwlink));
