// SPDX-License-Identifier: GPL-3.0-or-later
// NumWorks' official firmware, from my.numworks.com. NumWorks only gives it to signed-in users, so the server signs
// in with the account in numworks-account.json (next to server.js, never served, never committed) and keeps the
// session in memory, signing in again when it expires. The page only ever gets the firmware.
// The page's requests read only from the disk cache (firmware-cache.js), which an hourly timer fills for every known
// model and channel (stable, beta).
//   /api/firmware/N0120.json   the latest offer as last checked ({ name, version, patch_level, ... }), plus versions: the
//                              firmware kept for that model (newest first, each with its channel), channels: each
//                              channel's offer, and cache: { lastChecked, offline }
//   /api/firmware/N0120.dfu    a kept firmware (?version= one of the versions, &channel= stable or beta; none: the latest)
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { FirmwareCache, normalizeModel, isModel } = require('./firmware-cache.js');

// (tools/test-numworks.mjs points these at a pretend my.numworks.com and account)
const NW = process.env.NUMWORKS_URL || 'https://my.numworks.com';
const ACCOUNT_FILE = process.env.NUMWORKS_ACCOUNT || path.join(__dirname, 'numworks-account.json');
const UA = 'nwa-toolkit (local)';
const RETRIES = 3;  // (the network can be flaky)

const jar = new Map();  // the session's cookies, name -> value
let signedIn = false;
let signingIn = null;   // the sign-in under way, shared by the requests waiting on it

// status: the HTTP status to answer with; code and params: what the page shows, in its language (err.<code> in
// public/i18n/), sent next to the English message as { error, code, params }
class HttpError extends Error {
  constructor(status, message, code, params = {}) { super(message); this.status = status; this.i18n = { code, params }; }
}
const fail = (message, code, params = {}) => ({ error: message, code, params });

// { email, password } from numworks-account.json, or null when there's none
function account() {
  if (!fs.existsSync(ACCOUNT_FILE)) return null;
  let a;
  try { a = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); } catch (e) {
    // JSON.parse's message can quote the file (the password with it): give only where the error is
    const where = /at position \d+(?: \(line \d+ column \d+\))?/.exec(e.message);
    throw new HttpError(500, 'numworks-account.json is not valid JSON' + (where ? ' (' + where[0] + ')' : ''), where ? 'nw.badJsonAt' : 'nw.badJson', { where: where?.[0] });
  }
  if (!a || typeof a.email !== 'string' || typeof a.password !== 'string' || !a.email || !a.password)
    throw new HttpError(500, 'numworks-account.json needs an "email" and a "password"', 'nw.needsFields');
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
      if (i >= RETRIES) throw new HttpError(502, 'Could not reach my.numworks.com: ' + e.message, 'nw.unreachable', { msg: e.message });
    }
  }
}

const toSignIn = (r) => r.status === 401 || (r.status >= 300 && r.status < 400 && /\/users\/sign_in/.test(r.headers.location || ''));

// my.numworks.com's sign-in form (Rails/Devise): get it for its CSRF token, then post the account to it.
// It answers a redirect when that worked, and the form again when it didn't.
async function signIn() {
  const a = account();
  if (!a) throw new HttpError(412, 'No numworks-account.json next to server.js (see README)', 'nw.noAccount');
  signedIn = false;
  jar.clear();
  const page = await retried('GET', '/users/sign_in', { accept: 'text/html' });
  const html = page.body.toString('utf8');
  const token = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html) || /name="csrf-token"[^>]*content="([^"]+)"/.exec(html);
  if (page.status !== 200 || !token) throw new HttpError(502, 'my.numworks.com\'s sign-in page has changed (HTTP ' + page.status + ')', 'nw.signInChanged', { status: page.status });
  const r = await retried('POST', '/users/sign_in', { accept: 'text/html', form: {
    authenticity_token: token[1].replace(/&#x2F;/g, '/').replace(/&amp;/g, '&'), 'user[email]': a.email, 'user[password]': a.password } });
  if (!(r.status >= 300 && r.status < 400) || toSignIn(r))
    throw new HttpError(401, 'my.numworks.com did not accept the email and password in numworks-account.json', 'nw.badLogin');
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
    if (attempt) throw new HttpError(401, 'my.numworks.com signed the account out again right after signing in', 'nw.signedOut');
  }
}

// what NumWorks offers now for a model on a channel: { name: the channel's file name, info: its .json }. The channel is
// the name NumWorks' updater uses for the file (stable.json, beta.json); HTTP 404 when it has no such model or channel.
async function fetchInfo(model, channel = 'stable') {
  const v = channel;
  const r = await get(`/firmwares/${model}/${encodeURIComponent(v)}.json`, 'application/json');
  if (r.status !== 200) throw new HttpError(r.status === 404 ? 404 : 502, `my.numworks.com: HTTP ${r.status} for ${model} ${v}.json`, 'nw.firmwareHttp', { status: r.status, file: `${model} ${v}.json` });
  try { return { name: v, info: JSON.parse(r.body.toString('utf8')) }; } catch { throw new HttpError(502, 'my.numworks.com did not send JSON for ' + model, 'nw.notJson', { model }); }
}

// that firmware's .dfu
async function fetchFirmware(model, name) {
  const r = await get(`/firmwares/${model}/${encodeURIComponent(name)}.dfu`, 'application/octet-stream');
  if (r.status !== 200) throw new HttpError(r.status === 404 ? 404 : 502, `my.numworks.com: HTTP ${r.status} for ${model} ${name}.dfu`, 'nw.firmwareHttp', { status: r.status, file: `${model} ${name}.dfu` });
  return r.body;
}

// the disk cache the page's requests read from (firmware-cache.js); my.numworks.com is only asked by its hourly check
const cache = new FirmwareCache({ dir: process.env.NWA_FW_CACHE || path.join(__dirname, 'cache', 'firmware'), fetchInfo, fetchFirmware,
  log: (m) => console.log(m) });

// answers /api/firmware/...; resolves false for other paths. Never reaches my.numworks.com itself.
async function handle(req, res, url, send) {
  const m = /^\/api\/firmware\/([0-9A-Za-z_]{1,64})\.(json|dfu)$/.exec(url.pathname);
  if (!m) return false;
  const [, raw, ext] = m, version = url.searchParams.get('version'), channel = url.searchParams.get('channel');
  const model = normalizeModel(raw);
  if (!isModel(model)) { send(res, 400, fail('Unknown model ' + raw, 'nw.unknownModel', { model: raw })); return true; }
  if (version && !/^[0-9A-Za-z._-]{1,40}$/.test(version)) { send(res, 400, fail('Bad version', 'nw.badVersion')); return true; }
  try {
    if (ext === 'json') { send(res, 200, cache.info(model)); return true; }
    const f = cache.firmware(model, version, channel || undefined);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.body.length, 'Cache-Control': 'no-store',
      'X-Firmware-Name': f.version, 'X-Firmware-Channel': f.channel });
    res.end(f.body);
  } catch (e) {
    if (!e.i18n) throw e;
    send(res, e.status || 502, { error: e.message, ...e.i18n });
  }
  return true;
}

// for /api/status: whether there's an account to sign in with (it isn't tried until the page asks for firmware)
function status() {
  try { return { account: !!account() }; } catch (e) { return { account: false, error: e.message, ...e.i18n }; }
}

module.exports = { handle, status, fetchInfo, fetchFirmware, cache, start: () => cache.start() };
