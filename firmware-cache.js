// SPDX-License-Identifier: GPL-3.0-or-later
// NumWorks' firmware, kept on disk. A timer checks my.numworks.com once at start and then every hour, for each
// calculator model this site has recognized; the page's requests only ever read what is kept here, so a page never
// waits on (or fails because of) my.numworks.com.
//   cache/firmware/index.json                       known models, when each was last checked, what NumWorks offered
//   cache/firmware/<model>/<version>/firmware.dfu   every firmware downloaded, kept for good (never overwritten)
//   cache/firmware/<model>/<version>/metadata.json  NumWorks' .json for it, plus its sha256, size and when it was saved
// A model is cached from the first time a page asks about it (a calculator of that model was connected). That first
// time, its first check is started right away rather than at the next hourly tick; after that, only the timer fetches.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const HOUR = 3600 * 1000;
const SEED_MODELS = ['N0120'];  // (the models this site had already seen when the cache was added)
const SAFE = /^[0-9A-Za-z._-]{1,40}$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// newest first: 24.10.1 > 24.4.0 > 23.2.6 (numeric parts compared as numbers)
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? +x : NaN, ny = /^\d+$/.test(y) ? +y : NaN;
    const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}
const newestFirst = (a, b) => compareVersions(b, a);

class CacheError extends Error {
  constructor(status, message, code, params = {}) { super(message); this.status = status; this.i18n = { code, params }; }
}

class FirmwareCache {
  // fetchInfo(model) -> { name, info }: the version name NumWorks offers now and its .json
  // fetchFirmware(model, name) -> Buffer: that firmware's .dfu
  constructor({ dir, fetchInfo, fetchFirmware, now = Date.now, interval = HOUR, timers = globalThis, log = () => {} }) {
    Object.assign(this, { dir, fetchInfo, fetchFirmware, now, interval, timers, log });
    this.indexFile = path.join(dir, 'index.json');
    this.index = this.load();
    this.running = null;
    this.modelRuns = new Map();
    this.timer = null;
  }

  load() {
    let ix = null;
    try { ix = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { /* none yet, or unreadable: start over */ }
    if (!ix || typeof ix !== 'object' || !Array.isArray(ix.knownModels)) ix = { knownModels: [...SEED_MODELS], lastChecked: null, models: {} };
    ix.models ||= {};
    for (const m of ix.knownModels) ix.models[m] ||= { firstSeen: null, lastChecked: null, latest: null, lastError: null, versions: {} };
    return ix;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 1));
    fs.renameSync(tmp, this.indexFile);
  }

  // the hourly check: once now, then every interval
  start() {
    this.refreshAll().catch((e) => this.log('Firmware check failed: ' + e.message));
    this.timer = this.timers.setInterval(() => this.refreshAll().catch((e) => this.log('Firmware check failed: ' + e.message)), this.interval);
    this.timer?.unref?.();
    return this;
  }
  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }

  // a page asked about this model: start caching it if it's new. -> true when it was new
  recognize(model) {
    if (this.index.knownModels.includes(model)) return false;
    this.index.knownModels.push(model);
    this.index.models[model] = { firstSeen: new Date(this.now()).toISOString(), lastChecked: null, latest: null, lastError: null, versions: {} };
    this.save();
    this.log(`Firmware cache: first ${model} seen, caching its firmware from now on`);
    this.refreshModel(model).catch(() => {});  // its first check (the timer does the rest)
    return true;
  }

  refreshAll() {
    this.running ||= (async () => {
      for (const m of [...this.index.knownModels]) await this.refreshModel(m);
      this.index.lastChecked = new Date(this.now()).toISOString();
      this.save();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  refreshModel(model) {
    if (!this.modelRuns.has(model)) this.modelRuns.set(model, this._refreshModel(model).finally(() => this.modelRuns.delete(model)));
    return this.modelRuns.get(model);
  }

  async _refreshModel(model) {
    const m = this.index.models[model];
    const at = new Date(this.now()).toISOString();
    try {
      const { name, info } = await this.fetchInfo(model);
      const version = String(info.version || name);
      if (!SAFE.test(version) || !SAFE.test(String(name))) throw new CacheError(502, 'my.numworks.com named a version this cache cannot keep', 'nw.noVersion');
      m.latest = { ...info, name, version };
      if (!this.verifiedFile(model, version)) await this.download(model, name, version, info);
      m.lastError = null;
    } catch (e) {
      m.lastError = { at, error: e.message, status: e.status || 502, code: e.i18n?.code || 'nw.unreachable', params: e.i18n?.params || { msg: e.message } };
      this.log(`Firmware check for ${model} failed (keeping the saved copies): ${e.message}`);
    }
    m.lastChecked = at;
    this.save();
  }

  versionDir(model, version) { return path.join(this.dir, model, version); }

  // the kept firmware file when it's there and matches its recorded sha256, else null
  verifiedFile(model, version) {
    const v = this.index.models[model]?.versions[version];
    if (!v) return null;
    const file = path.join(this.versionDir(model, version), 'firmware.dfu');
    if (!fs.existsSync(file)) return null;
    const b = fs.readFileSync(file);
    return sha256(b) === v.sha256 ? b : null;
  }

  async download(model, name, version, info) {
    const body = await this.fetchFirmware(model, name);
    const dir = this.versionDir(model, version), file = path.join(dir, 'firmware.dfu');
    const hash = sha256(body);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      // a file already kept for this version: never replaced. It's trusted only when the new download agrees with it.
      if (sha256(fs.readFileSync(file)) !== hash) {
        this.log(`Firmware cache: ${model} ${version} downloaded again with different bytes; the kept file is left as it is`);
        throw new CacheError(502, `my.numworks.com sent different bytes for ${model} ${version} than the copy kept`, 'fw.cacheConflict', { model, version });
      }
    } else {
      fs.writeFileSync(file + '.tmp', body);
      fs.renameSync(file + '.tmp', file);
    }
    const meta = { ...info, name, version, model, sha256: hash, size: body.length, savedAt: new Date(this.now()).toISOString() };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 1));
    this.index.models[model].versions[version] = { patch_level: info.patch_level ?? null, sha256: hash, size: body.length, savedAt: meta.savedAt };
    this.log(`Firmware cache: saved ${model} ${version} (${body.length} bytes, sha256 ${hash})`);
  }

  // what the page gets for /api/firmware/<model>.json: NumWorks' latest offer as last seen, the versions kept, and
  // whether the last check failed. Throws when there's nothing kept to answer with.
  info(model) {
    this.recognize(model);
    const m = this.index.models[model];
    const versions = Object.entries(m.versions).map(([version, v]) => ({ version, ...v })).sort((a, b) => newestFirst(a.version, b.version));
    const cache = { lastChecked: m.lastChecked, offline: !!m.lastError, error: m.lastError && { error: m.lastError.error, code: m.lastError.code, params: m.lastError.params } };
    if (!m.latest && !versions.length) {
      if (m.lastError) throw new CacheError(m.lastError.status, m.lastError.error, m.lastError.code, m.lastError.params);
      throw new CacheError(503, `No firmware kept for the ${model} yet: it is being fetched, check again in a minute`, 'fw.cachePending', { model });
    }
    // the newest offer, or (never reached NumWorks) the newest version kept
    const latest = m.latest || (() => { const v = versions[0]; const meta = this.meta(model, v.version) || {}; return { ...meta, version: v.version }; })();
    const kept = m.versions[latest.version];
    return { ...latest, name: latest.version, size: latest.size || kept?.size, cached: !!kept, versions, cache };
  }

  meta(model, version) {
    try { return JSON.parse(fs.readFileSync(path.join(this.versionDir(model, version), 'metadata.json'), 'utf8')); } catch { return null; }
  }

  // the .dfu for /api/firmware/<model>.dfu?version=<version> (no version: the latest offered)
  firmware(model, version) {
    this.recognize(model);
    const m = this.index.models[model];
    const v = version || m.latest?.version;
    if (!v) throw new CacheError(503, `No firmware kept for the ${model} yet`, 'fw.cachePending', { model });
    const b = this.verifiedFile(model, v);
    if (!b) throw new CacheError(404, `Epsilon ${v} for the ${model} is not kept on this computer`, 'fw.notCached', { model, version: v });
    return { version: v, body: b };
  }
}

module.exports = { FirmwareCache, CacheError, compareVersions, HOUR };
