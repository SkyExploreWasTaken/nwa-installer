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
let deviceMode = 'up';  // 'up' | 'down' (connections dropped) | 'slow' (answers after the server's timeout)
const SERIAL = '12001A000651353031393332';
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/devices/') && req.url !== '/devices/upgrade') {
    if (deviceMode === 'down') return req.socket.destroy();
    if (deviceMode === 'slow') return setTimeout(() => { if (!res.writableEnded) { res.writeHead(200); res.end('{}'); } }, 1500);
  }
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
  if (req.url === '/devices/' + SERIAL + '.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: 42, serial_number: SERIAL, device_model: { id: 7, name: 'N0120' }, software_version: '26.4.0',
      software_patch_level: 'cc9262e', user: { email: EMAIL, name: 'Someone' }, created_at: '2025-01-01' }));
  }
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
  NWA_FW_CACHE: path.join(dir, 'cache'), NWA_DEVICE_CACHE: path.join(dir, 'devices'), NWA_DEVICE_TIMEOUT: '600' });
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
  // /api/device/<serial>: what NumWorks says about a calculator, and nothing about the account
  fs.writeFileSync(accountFile, JSON.stringify({ email: EMAIL, password: PASSWORD }));
  const device = async (serial) => {
    const out = {};
    const res = { writeHead() {}, end() {} };
    await nw.handle({}, res, new URL('http://localhost/api/device/' + serial), (r, status, body) => Object.assign(out, { status, body }));
    return out;
  };
  let d = await device(SERIAL.toLowerCase());
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(d.body, { model: 'N0120', softwareVersion: '26.4.0', patchLevel: 'cc9262e', cached: false }, 'only model and version, no account data');
  const kept = fs.readFileSync(path.join(dir, 'devices', SERIAL + '.json'), 'utf8');
  assert.ok(!kept.includes(EMAIL) && !kept.includes('Someone'), 'the cache holds no account data either');
  d = await device('00000000000000000000000A');
  assert.equal(d.status, 404, 'not registered');
  assert.equal(d.body.code, 'device.notFound');
  assert.equal((await device('nope')).status, 400, 'bad serial');
  assert.equal((await device('12001A00065135303139333')).status, 400, '23 hex digits');
  deviceMode = 'down';
  d = await device(SERIAL);
  assert.deepEqual([d.status, d.body.model, d.body.cached], [200, 'N0120', true], 'offline: what was kept');
  d = await device('00000000000000000000000B');
  assert.deepEqual([d.status, d.body.code], [503, 'device.unavailable'], 'offline, nothing kept');
  deviceMode = 'slow';
  const t0 = Date.now();
  d = await device(SERIAL);
  assert.ok(Date.now() - t0 < 1400, 'gives up after its timeout');
  assert.deepEqual([d.status, d.body.cached], [200, true], 'too slow: what was kept');
  deviceMode = 'up';
  console.log('numworks.js: all good');
} finally {
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
