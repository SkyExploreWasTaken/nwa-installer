// SPDX-License-Identifier: GPL-3.0-or-later
// Tests numworks.js (signing in to my.numworks.com, fetching the firmware into its cache) against a pretend my.numworks.com that
// works like the real one: a Rails/Devise sign-in form with a CSRF token, and pages that send you to it when signed out.
//   node tools/test-numworks.mjs
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMAIL = 'test@example.com', PASSWORD = 'test-password';
const FIRMWARE = Buffer.from('DfuSe pretend firmware');

// the pretend my.numworks.com
const sessions = new Map();  // session id -> { token, user }
let nextId = 1, signIns = 0, dfuDownloads = 0;
const cookieOf = (req) => /(?:^|;\s*)_nw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const fake = http.createServer((req, res) => {
  let id = cookieOf(req);
  if (!sessions.has(id)) { id = String(nextId++); sessions.set(id, { token: 'tok' + id + '/+=', user: null }); }
  const s = sessions.get(id);
  res.setHeader('Set-Cookie', `_nw_session=${id}; path=/; HttpOnly`);
  const redirect = (to) => { res.writeHead(302, { Location: 'http://' + req.headers.host + to }); res.end(); };
  if (req.url === '/users/sign_in' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<meta name="csrf-token" content="x"><form action="/users/sign_in" method="post">
      <input type="hidden" name="authenticity_token" value="${s.token.replace(/\//g, '&#x2F;')}" autocomplete="off">
      <input type="email" name="user[email]"><input type="password" name="user[password]"></form>`);
  }
  if (req.url === '/users/sign_in' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    return req.on('end', () => {
      const f = new URLSearchParams(body);
      if (f.get('authenticity_token') !== s.token) { res.writeHead(422); return res.end('bad token'); }
      if (f.get('user[email]') !== EMAIL || f.get('user[password]') !== PASSWORD) { res.writeHead(422); return res.end('<form>'); }
      signIns++;
      sessions.delete(id);  // Devise starts a new session on sign-in
      const nid = String(nextId++);
      sessions.set(nid, { token: 'tok' + nid, user: EMAIL });
      res.setHeader('Set-Cookie', `_nw_session=${nid}; path=/; HttpOnly`);
      redirect('/');
    });
  }
  if (!s.user) return req.url.startsWith('/firmwares/') ? (res.writeHead(401), res.end()) : redirect('/users/sign_in');
  if (req.url === '/devices/upgrade') { res.writeHead(200); return res.end('<div data-settings="{&quot;flash&quot;:&quot;stable&quot;}">'); }
  if (req.url === '/firmwares/N0120/stable.json') { res.writeHead(200); return res.end('{"version":"24.4.0","patch_level":"abc"}'); }
  if (req.url === '/firmwares/N0120/stable.dfu') { dfuDownloads++; res.writeHead(200); return res.end(FIRMWARE); }
  res.writeHead(404); res.end();
});
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));

// numworks.js in this process, its firmware cache in a temporary folder (the hourly timer isn't started: the test
// runs the checks itself, as the timer would)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nwa-test-'));
const accountFile = path.join(dir, 'numworks-account.json');
Object.assign(process.env, { NUMWORKS_URL: 'http://127.0.0.1:' + fake.address().port, NUMWORKS_ACCOUNT: accountFile,
  NWA_FW_CACHE: path.join(dir, 'cache') });
const nw = createRequire(import.meta.url)(path.join(repo, 'numworks.js'));
nw.cache.log = () => {};
const err = (f) => { try { f(); } catch (e) { return e; } assert.fail('expected an error'); };

try {
  assert.deepEqual(nw.status(), { account: false }, 'no account file');
  await nw.cache.refreshAll();
  assert.equal(err(() => nw.cache.info('N0120')).status, 412, 'no account: the check failed, nothing kept');

  fs.writeFileSync(accountFile, JSON.stringify({ email: EMAIL, password: 'wrong' }));
  assert.equal(nw.status().account, true);
  await nw.cache.refreshAll();
  assert.equal(err(() => nw.cache.info('N0120')).status, 401, 'wrong password');

  fs.writeFileSync(accountFile, JSON.stringify({ email: EMAIL, password: PASSWORD }));
  await nw.cache.refreshAll();
  const info = nw.cache.info('N0120');
  assert.equal(info.version, '24.4.0');
  assert.equal(info.patch_level, 'abc');
  assert.equal(info.cache.offline, false);
  assert.deepEqual(info.versions.map((v) => v.version), ['24.4.0']);
  assert.deepEqual(nw.cache.firmware('N0120', '24.4.0').body, FIRMWARE);
  assert.equal(signIns, 1, 'signed in once, then kept the session');

  sessions.clear();  // the session expires
  await nw.cache.refreshAll();
  assert.equal(signIns, 2, 'signs in again');
  assert.equal(dfuDownloads, 1, 'a version already kept is not downloaded again');

  fs.writeFileSync(accountFile, '{ nope');
  assert.match(nw.status().error, /not valid JSON/);
  console.log('numworks.js: all good');
} finally {
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
