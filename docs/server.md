# The server

`node server.js [port]` starts a plain Node `http` server bound to `127.0.0.1` only.

## What it serves
- The page from `public/`, with `Cache-Control: no-cache`.
- `/api/status`: `{ account: true|false }`.
- `/api/firmware/<model>.json`: the latest offer for the model, plus `versions` (kept firmware, newest first, with
  channel), `channels`, and `cache: { lastChecked, offline }`.
- `/api/firmware/<model>.dfu[?version=&channel=]`: a kept firmware (the latest if none given), with
  `X-Firmware-Name` and `X-Firmware-Channel` headers.
- `/numplay/...`, `/site-config.json`, `lib/build-mode.js` (generated from `NODE_ENV`).
- Anything else under `/api/` is a 404 `server.noApi`.

## Protections
- Host check: only `localhost`, `127.0.0.1` and `ALLOWED_HOSTS`.
- `/api/` refuses cross-site requests (`Sec-Fetch-Site` must be `same-origin` when present).
- Only GET and HEAD for non-API paths.
- Security headers on every response: a strict Content-Security-Policy (`wasm-unsafe-eval` only for the linker),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- `numworks-account.json`, `node_modules` and `.git` are never served; paths cannot escape `public/`.

## Firmware cache (`firmware-cache.js`)
A timer checks my.numworks.com at start and every hour for each known model (`N0110`, `N0115`, `N0120`, the
Portugal prototype) and channel (`stable`, `beta`). Pages only read the disk:
```
cache/firmware/index.json
cache/firmware/<model>/<channel>/<version>/firmware.dfu
cache/firmware/<model>/<channel>/<version>/metadata.json   (NumWorks' json, sha256, size, saved time)
```
Downloaded firmware is kept for good. If NumWorks later sends different bytes for a version already saved, the
saved copy is kept (`fw.cacheConflict`). A model or channel NumWorks does not offer (404) is skipped quietly. The
N0100 is never cached. If nothing is saved yet, the page is told `fw.cachePending`; try again in a minute.

## Startup line
```
Nwa Toolkit on http://localhost:8642/  (firmware updates: NumWorks account found)
```
shows `no numworks-account.json` when the account file is absent.

## Running behind https
WebUSB needs a secure context. Put a reverse proxy with https in front, set `ALLOWED_HOSTS` to its host name, and
`NODE_ENV=production`. The server still binds only to `127.0.0.1`.
