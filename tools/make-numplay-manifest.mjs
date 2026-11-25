// SPDX-License-Identifier: GPL-3.0-or-later
// Builds numplay-manifest.json: the NumPlay files the server may fetch, pinned to fixed commits of Mason363/NumPlay,
// with each file's sha256. The server (numplay.js) fetches only these paths, only at these commits, and refuses any
// file whose sha256 differs. To move to a newer NumPlay, review its changes, then:
//   node tools/make-numplay-manifest.mjs <kit-branch-sha> <main-branch-sha>
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const [kitSha, mainSha] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(kitSha || '') || !/^[0-9a-f]{40}$/.test(mainSha || ''))
  throw new Error('usage: node tools/make-numplay-manifest.mjs <kit-sha> <main-sha> (full 40-hex commit SHAs)');
const REPO = 'Mason363/NumPlay', H = { headers: { 'User-Agent': 'nwa-installer (local)' } };
// the kit's files the builder uses (not the other calculators' ports nor the site's thumbnails)
const USED = (p) => !/^(ports|thumbs)\//.test(p);

const tree = await (await fetch(`https://api.github.com/repos/${REPO}/git/trees/${kitSha}?recursive=1`, H)).json();
if (tree.truncated || !tree.tree) throw new Error('could not list the kit tree');
const jobs = tree.tree.filter((t) => t.type === 'blob' && USED(t.path)).map((t) => ({ key: 'kit/' + t.path, sha: kitSha, src: t.path }));
jobs.push({ key: 'apps.js', sha: mainSha, src: 'customize/apps.js' }, { key: 'pico.js', sha: mainSha, src: 'customize/pico.js' });

const files = {};
let i = 0;
async function worker() {
  while (i < jobs.length) {
    const j = jobs[i++];
    for (let a = 0; ; a++) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${j.sha}/${j.src}`, H);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const b = Buffer.from(await r.arrayBuffer());
        files[j.key] = { sha256: createHash('sha256').update(b).digest('hex'), size: b.length };
        break;
      } catch (e) { if (a >= 3) throw new Error(j.src + ': ' + e.message); }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
const out = { repo: REPO, kitCommit: kitSha, mainCommit: mainSha,
  sources: { 'kit/': `https://raw.githubusercontent.com/${REPO}/${kitSha}/`, 'apps.js': `https://raw.githubusercontent.com/${REPO}/${mainSha}/customize/apps.js`,
    'pico.js': `https://raw.githubusercontent.com/${REPO}/${mainSha}/customize/pico.js` }, files: sorted };
writeFileSync(fileURLToPath(new URL('../numplay-manifest.json', import.meta.url)), JSON.stringify(out, null, 1) + '\n');
console.log(Object.keys(sorted).length + ' files');
