// SPDX-License-Identifier: GPL-3.0-or-later
// NumWorks' firmware, kept on disk. A timer checks my.numworks.com once at start and then every hour, for every known
// calculator model and each release channel (stable, beta); the page's requests only ever read what is kept here, so a
// page never waits on (or fails because of) my.numworks.com.
//   cache/firmware/index.json                                  known models, per channel: last check, what was offered
//   cache/firmware/<model>/<channel>/<version>/firmware.dfu    every firmware downloaded, kept for good (never overwritten)
//   cache/firmware/<model>/<channel>/<version>/metadata.json   NumWorks' .json for it, plus sha256, size, when saved
// The models this installer supports are known from the start (SEED_MODELS; not the N0100). A model or channel NumWorks doesn't offer
// (HTTP 404) is normal: logged and skipped, not an error. A model not on the list that a page asks about is added, and
// its first check started right away rather than at the next hourly tick; after that, only the timer fetches.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const HOUR = 3600 * 1000;
const SEED_MODELS = ['N0110', 'N0115', 'N0120', 'N0120_PORTUGAL_PROTOTYPE_20210930'];
// models this installer doesn't support: never cached, and dropped from an index kept from before
const UNSUPPORTED = ['N0100'];
const CHANNELS = ['stable', 'beta'];
const SAFE = /^[0-9A-Za-z._-]{1,40}$/;
// a model name as the site identifies them (upper case: N0120, N0120_PORTUGAL_PROTOTYPE_20210930)
const MODEL = /^N\d{4}(?:_[A-Z0-9]+)*$/;
const normalizeModel = (m) => String(m || '').trim().toUpperCase();
const isModel = (m) => MODEL.test(m) && m.length <= 64;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// newest first: 24.10.1 > 24.4.0 > 23.2.6 (numeric parts compared as numbers)
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const c = /^\d+$/.test(x) && /^\d+$/.test(y) ? +x - +y : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}
const newestFirst = (a, b) => compareVersions(b, a);

class CacheError extends Error {
  constructor(status, message, code, params = {}) { super(message); this.status = status; this.i18n = { code, params }; }
}

const emptyChannel = () => ({ lastChecked: null, latest: null, lastError: null, missing: false, versions: {} });
const emptyModel = (firstSeen = null) => ({ firstSeen, channels: Object.fromEntries(CHANNELS.map((c) => [c, emptyChannel()])) });

class FirmwareCache {
  // fetchInfo(model, channel) -> { name, info }: that channel's offer and its .json (an error with status 404 when
  //   NumWorks has no such model or channel)
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
    if (!ix || typeof ix !== 'object' || !Array.isArray(ix.knownModels)) ix = { knownModels: [], lastChecked: null, models: {} };
    ix.models ||= {};
    ix.knownModels = [...new Set([...SEED_MODELS, ...ix.knownModels.map(normalizeModel)])].filter((m) => isModel(m) && !UNSUPPORTED.includes(m));
    for (const m of UNSUPPORTED) delete ix.models[m];
    for (const m of ix.knownModels) {
      ix.models[m] ||= emptyModel();
      ix.models[m].channels ||= {};
      for (const c of CHANNELS) ix.models[m].channels[c] ||= emptyChannel();
    }
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
    const run = () => this.refreshAll().catch((e) => this.log('Firmware check failed: ' + e.message));
    run();
    this.timer = this.timers.setInterval(run, this.interval);
    this.timer?.unref?.();
    return this;
  }
  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }

  // a page asked about this model: start caching it if it's new. -> its normalized name
  recognize(model) {
    const m = normalizeModel(model);
    if (!isModel(m)) throw new CacheError(400, 'Unknown model ' + model, 'nw.unknownModel', { model });
    if (UNSUPPORTED.includes(m)) throw new CacheError(400, 'The ' + m + ' is not supported by this installer', 'calc.n0100', {});
    if (this.index.knownModels.includes(m)) return m;
    this.index.knownModels.push(m);
    this.index.models[m] = emptyModel(new Date(this.now()).toISOString());
    this.save();
    this.log(`Firmware cache: first ${m} seen, caching its firmware from now on`);
    this.refreshModel(m).catch(() => {});  // its first check (the timer does the rest)
    return m;
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
    if (!this.modelRuns.has(model)) this.modelRuns.set(model, (async () => {
      for (const c of CHANNELS) await this.refreshChannel(model, c);
      this.save();
    })().finally(() => this.modelRuns.delete(model)));
    return this.modelRuns.get(model);
  }

  async refreshChannel(model, channel) {
    const ch = this.index.models[model].channels[channel];
    const at = new Date(this.now()).toISOString();
    try {
      const { name, info } = await this.fetchInfo(model, channel);
      const version = String(info.version || name);
      if (!SAFE.test(version) || !SAFE.test(String(name))) throw new CacheError(502, 'my.numworks.com named a version this cache cannot keep', 'nw.noVersion');
      ch.latest = { ...info, name, version };
      ch.missing = false;
      if (!this.verifiedFile(model, channel, version)) await this.download(model, channel, name, version, info);
      ch.lastError = null;
    } catch (e) {
      if (e.status === 404) {
        // NumWorks has no such model or channel: normal, nothing to keep
        if (!ch.missing) this.log(`Firmware cache: NumWorks offers no ${channel} firmware for the ${model}, skipped`);
        ch.missing = true;
        ch.lastError = null;
      } else {
        ch.lastError = { at, error: e.message, status: e.status || 502, code: e.i18n?.code || 'nw.unreachable', params: e.i18n?.params || { msg: e.message } };
        this.log(`Firmware check for ${model} ${channel} failed (keeping the saved copies): ${e.message}`);
      }
    }
    ch.lastChecked = at;
  }

  versionDir(model, channel, version) { return path.join(this.dir, model, channel, version); }

  // the kept firmware file when it's there and matches its recorded sha256, else null
  verifiedFile(model, channel, version) {
    const v = this.index.models[model]?.channels[channel]?.versions[version];
    if (!v) return null;
    const file = path.join(this.versionDir(model, channel, version), 'firmware.dfu');
    if (!fs.existsSync(file)) return null;
    const b = fs.readFileSync(file);
    return sha256(b) === v.sha256 ? b : null;
  }

  async download(model, channel, name, version, info) {
    const body = await this.fetchFirmware(model, name);
    const dir = this.versionDir(model, channel, version), file = path.join(dir, 'firmware.dfu');
    const hash = sha256(body);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      // a file already kept for this version: never replaced. It's trusted only when the new download agrees with it.
      if (sha256(fs.readFileSync(file)) !== hash) {
        this.log(`Firmware cache: ${model} ${channel} ${version} downloaded again with different bytes; the kept file is left as it is`);
        throw new CacheError(502, `my.numworks.com sent different bytes for ${model} ${version} than the copy kept`, 'fw.cacheConflict', { model, version });
      }
    } else {
      fs.writeFileSync(file + '.tmp', body);
      fs.renameSync(file + '.tmp', file);
    }
    const meta = { ...info, name, version, model, channel, sha256: hash, size: body.length, savedAt: new Date(this.now()).toISOString() };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 1));
    this.index.models[model].channels[channel].versions[version] = { patch_level: info.patch_level ?? null, sha256: hash, size: body.length, savedAt: meta.savedAt };
    this.log(`Firmware cache: saved ${model} ${channel} ${version} (${body.length} bytes, sha256 ${hash})`);
  }

  meta(model, channel, version) {
    try { return JSON.parse(fs.readFileSync(path.join(this.versionDir(model, channel, version), 'metadata.json'), 'utf8')); } catch { return null; }
  }

  // what the page gets for /api/firmware/<model>.json: the stable channel's latest offer as last seen (beta's when
  // there's no stable), every version kept in either channel (a version in both is listed once, as stable), newest
  // first, each with its channel, and whether the last check failed. Throws when there's nothing to answer with.
  info(model) {
    model = this.recognize(model);
    const m = this.index.models[model];
    const seen = new Map();
    for (const c of CHANNELS) for (const [version, v] of Object.entries(m.channels[c].versions)) if (!seen.has(version)) seen.set(version, { version, channel: c, ...v });
    const versions = [...seen.values()].sort((a, b) => newestFirst(a.version, b.version));
    const chans = CHANNELS.map((c) => [c, m.channels[c]]);
    const errored = chans.find(([, ch]) => ch.lastError);
    const lastChecked = chans.map(([, ch]) => ch.lastChecked).filter(Boolean).sort().pop() || null;
    const cache = { lastChecked, offline: !!errored, error: errored && { error: errored[1].lastError.error, code: errored[1].lastError.code, params: errored[1].lastError.params } };
    const offers = Object.fromEntries(chans.filter(([, ch]) => ch.latest).map(([c, ch]) => [c, { version: ch.latest.version, patch_level: ch.latest.patch_level ?? null, cached: !!ch.versions[ch.latest.version] }]));
    const [mainChannel, main] = chans.find(([, ch]) => ch.latest) || [];
    if (!main && !versions.length) {
      if (errored) { const e = errored[1].lastError; throw new CacheError(e.status, e.error, e.code, e.params); }
      if (chans.every(([, ch]) => ch.missing)) throw new CacheError(404, `NumWorks offers no firmware for the ${model}`, 'fw.noneForModel', { model });
      throw new CacheError(503, `No firmware kept for the ${model} yet: it is being fetched, check again in a minute`, 'fw.cachePending', { model });
    }
    // the newest offer, or (never reached NumWorks) the newest version kept
    const latest = main ? { ...main.latest, channel: mainChannel }
      : { ...(this.meta(model, versions[0].channel, versions[0].version) || {}), version: versions[0].version, channel: versions[0].channel };
    const kept = m.channels[latest.channel].versions[latest.version];
    return { ...latest, name: latest.version, size: latest.size || kept?.size, cached: !!kept, versions, channels: offers, cache };
  }

  // the .dfu for /api/firmware/<model>.dfu?version=<version>[&channel=beta] (no version: the latest offered)
  firmware(model, version, channel) {
    model = this.recognize(model);
    if (channel && !CHANNELS.includes(channel)) throw new CacheError(400, 'Unknown channel ' + channel, 'fw.badChannel', { channel });
    const m = this.index.models[model];
    const order = channel ? [channel] : CHANNELS;
    const v = version || order.map((c) => m.channels[c].latest?.version).find(Boolean);
    if (!v) throw new CacheError(503, `No firmware kept for the ${model} yet`, 'fw.cachePending', { model });
    for (const c of order) {
      const b = this.verifiedFile(model, c, v);
      if (b) return { version: v, channel: c, body: b };
    }
    throw new CacheError(404, `Epsilon ${v} for the ${model} is not kept on this computer`, 'fw.notCached', { model, version: v });
  }
}

module.exports = { FirmwareCache, CacheError, compareVersions, normalizeModel, isModel, HOUR, SEED_MODELS, UNSUPPORTED, CHANNELS };
