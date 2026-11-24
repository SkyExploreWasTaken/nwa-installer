// SPDX-License-Identifier: GPL-3.0-or-later
// NumWorks' official firmware, from my.numworks.com. NumWorks only gives it to signed-in users, so the server signs
// in with the account in numworks-account.json (next to server.js, never served, never committed) and keeps the
// session in memory, signing in again when it expires. The page only ever gets the firmware.
//   /api/firmware/N0120.json   what my.numworks.com offers now for that model ({ name, version, patch_level, ... })
//   /api/firmware/N0120.dfu    its firmware (?version= to ask for the one the .json named)
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');

// (tools/test-numworks.mjs points these at a pretend my.numworks.com and account)
const NW = process.env.NUMWORKS_URL || 'https://my.numworks.com';
const ACCOUNT_FILE = process.env.NUMWORKS_ACCOUNT || path.join(__dirname, 'numworks-account.json');
const MODELS = new Set(['N0100', 'N0110', 'N0115', 'N0120']);
const UA = 'nwa-installer (local)';
const RETRIES = 3;  // (the network can be flaky)

const jar = new Map();  // the session's cookies, name -> value
let signedIn = false;
let signingIn = null;   // the sign-in under way, shared by the requests waiting on it

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// { email, password } from numworks-account.json, or null when there's none
function account() {
  if (!fs.existsSync(ACCOUNT_FILE)) return null;
  let a;
  try { a = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); } catch (e) {
    // JSON.parse's message can quote the file (the password with it): give only where the error is
    const where = /at position \d+(?: \(line \d+ column \d+\))?/.exec(e.message);
    throw new HttpError(500, 'numworks-account.json is not valid JSON' + (where ? ' (' + where[0] + ')' : ''));
  }
  if (!a || typeof a.email !== 'string' || typeof a.password !== 'string' || !a.email || !a.password)
    throw new HttpError(500, 'numworks-account.json needs an "email" and a "password"');
  return a;
}

// one request to my.numworks.com with the session's cookies, which it updates; no redirects followed.
// Resolves { status, headers, body: Buffer }.
function request(method, p, { accept = '*/*', form } = {}) {
  const body = form && new URLSearchParams(form).toString();
  const headers = { Accept: accept, 'User-Agent': UA };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
  if (body) Object.assign(headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body),
    Origin: NW, Referer: NW + p });
  return new Promise((ok, no) => {
    const req = (NW.startsWith('https:') ? https : http).request(NW + p, { method, headers }, (res) => {
      for (const c of res.headers['set-cookie'] || []) {
        const [pair, ...attrs] = c.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
        const gone = !value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=.*19[67]\d/i.test(a));
        if (gone) jar.delete(name); else jar.set(name, value);
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', no);
    });
    req.on('error', no);
    req.setTimeout(60000, () => req.destroy(new Error('my.numworks.com timed out')));
    req.end(body);
  });
}

// the same, again when the network fails
async function retried(...args) {
  for (let i = 1; ; i++) {
    try { return await request(...args); } catch (e) {
      if (i >= RETRIES) throw new HttpError(502, 'Could not reach my.numworks.com: ' + e.message);
    }
  }
}

const toSignIn = (r) => r.status === 401 || (r.status >= 300 && r.status < 400 && /\/users\/sign_in/.test(r.headers.location || ''));

// my.numworks.com's sign-in form (Rails/Devise): get it for its CSRF token, then post the account to it.
// It answers a redirect when that worked, and the form again when it didn't.
async function signIn() {
  const a = account();
  if (!a) throw new HttpError(412, 'No numworks-account.json next to server.js (see README)');
  signedIn = false;
  jar.clear();
  const page = await retried('GET', '/users/sign_in', { accept: 'text/html' });
  const html = page.body.toString('utf8');
  const token = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html) || /name="csrf-token"[^>]*content="([^"]+)"/.exec(html);
  if (page.status !== 200 || !token) throw new HttpError(502, 'my.numworks.com\'s sign-in page has changed (HTTP ' + page.status + ')');
  const r = await retried('POST', '/users/sign_in', { accept: 'text/html', form: {
    authenticity_token: token[1].replace(/&#x2F;/g, '/').replace(/&amp;/g, '&'), 'user[email]': a.email, 'user[password]': a.password } });
  if (!(r.status >= 300 && r.status < 400) || toSignIn(r))
    throw new HttpError(401, 'my.numworks.com did not accept the email and password in numworks-account.json');
  signedIn = true;
}

function ensureSignedIn(again) {
  if (again || !signedIn) signingIn ||= signIn().finally(() => { signingIn = null; });
  return signingIn || Promise.resolve();
}

// GET a page of my.numworks.com as the account, signing in first when needed, and once more if the session expired
async function get(p, accept) {
  for (let attempt = 0; ; attempt++) {
    await ensureSignedIn(attempt > 0);
    const r = await retried('GET', p, { accept });
    if (!toSignIn(r)) return r;
    if (attempt) throw new HttpError(401, 'my.numworks.com signed the account out again right after signing in');
  }
}

// the version NumWorks' updater page offers now: its `flash` setting, in the page's HTML ("stable" for most accounts)
async function latestVersion() {
  const r = await get('/devices/upgrade', 'text/html');
  if (r.status !== 200) throw new HttpError(502, 'my.numworks.com/devices/upgrade: HTTP ' + r.status);
  const html = r.body.toString('utf8').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const m = /[\s:"']flash["']?\s*[=:]\s*["']*([0-9A-Za-z._-]+)/.exec(html);
  if (!m) throw new HttpError(502, 'Could not find the firmware version on my.numworks.com/devices/upgrade');
  return m[1];
}

async function firmware(res, model, ext, version, send) {
  if (!MODELS.has(model)) return send(res, 400, { error: 'Unknown model ' + model });
  if (version && !/^[0-9A-Za-z._-]{1,40}$/.test(version)) return send(res, 400, { error: 'Bad version' });
  const v = version || await latestVersion();
  const r = await get(`/firmwares/${model}/${encodeURIComponent(v)}.${ext}`, ext === 'json' ? 'application/json' : 'application/octet-stream');
  if (r.status !== 200) return send(res, r.status === 404 ? 404 : 502, { error: `my.numworks.com: HTTP ${r.status} for ${model} ${v}.${ext}` });
  if (ext === 'json') {
    let info;
    try { info = JSON.parse(r.body.toString('utf8')); } catch { return send(res, 502, { error: 'my.numworks.com did not send JSON for ' + model }); }
    return send(res, 200, { name: v, ...info });
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': r.body.length, 'Cache-Control': 'no-store',
    'X-Firmware-Name': v });
  res.end(r.body);
}

// answers /api/firmware/...; resolves false for other paths
async function handle(req, res, url, send) {
  const m = /^\/api\/firmware\/(N\d{4})\.(json|dfu)$/.exec(url.pathname);
  if (!m) return false;
  await firmware(res, m[1], m[2], url.searchParams.get('version'), send);
  return true;
}

// for /api/status: whether there's an account to sign in with (it isn't tried until the page asks for firmware)
function status() {
  try { return { account: !!account() }; } catch (e) { return { account: false, error: e.message }; }
}

module.exports = { handle, status };
