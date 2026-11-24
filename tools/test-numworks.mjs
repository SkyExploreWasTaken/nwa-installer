// SPDX-License-Identifier: GPL-3.0-or-later
// Tests numworks.js (signing in to my.numworks.com, fetching the firmware) against a pretend my.numworks.com that
// works like the real one: a Rails/Devise sign-in form with a CSRF token, and pages that send you to it when signed out.
//   node tools/test-numworks.mjs
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMAIL = 'test@example.com', PASSWORD = 'test-password';
const FIRMWARE = Buffer.from('DfuSe pretend firmware');

// the pretend my.numworks.com
const sessions = new Map();  // session id -> { token, user }
let nextId = 1, signIns = 0;
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
  if (req.url === '/firmwares/N0120/stable.dfu') { res.writeHead(200); return res.end(FIRMWARE); }
  res.writeHead(404); res.end();
});
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));

// the installer's server, signed in to it
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nwa-test-'));
const accountFile = path.join(dir, 'numworks-account.json');
const port = 18642 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [path.join(repo, 'server.js'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, NUMWORKS_URL: 'http://127.0.0.1:' + fake.address().port, NUMWORKS_ACCOUNT: accountFile } });
await new Promise((ok) => server.stdout.once('data', ok));
const api = async (p) => {
  const r = await fetch(`http://localhost:${port}/api/${p}`);
  return { status: r.status, body: r.headers.get('content-type') === 'application/json' ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

try {
  let r = await api('status');
  assert.deepEqual(r.body, { account: false }, 'no account file');
  assert.equal((await api('firmware/N0120.json')).status, 412);

  fs.writeFileSync(accountFile, JSON.stringify({ email: EMAIL, password: 'wrong' }));
  assert.equal((await api('status')).body.account, true);
  r = await api('firmware/N0120.json');
  assert.equal(r.status, 401, 'wrong password');

  fs.writeFileSync(accountFile, JSON.stringify({ email: EMAIL, password: PASSWORD }));
  r = await api('firmware/N0120.json');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { name: 'stable', version: '24.4.0', patch_level: 'abc' });
  r = await api('firmware/N0120.dfu?version=stable');
  assert.deepEqual(r.body, FIRMWARE);
  assert.equal(signIns, 1, 'signed in once, then kept the session');

  sessions.clear();  // the session expires
  r = await api('firmware/N0120.dfu?version=stable');
  assert.deepEqual(r.body, FIRMWARE, 'signs in again');
  assert.equal(signIns, 2);

  assert.equal((await api('firmware/N9999.json')).status, 400);
  fs.writeFileSync(accountFile, '{ nope');
  assert.match((await api('status')).body.error, /not valid JSON/);
  console.log('numworks.js: all good');
} finally {
  server.kill();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
