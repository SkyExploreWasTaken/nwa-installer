# Testing

## Automated: `npm test`
Runs, in order:
1. `tools/test-numworks.mjs`: starts a pretend my.numworks.com (a Devise-style sign-in with CSRF token and
   redirects when signed out) and checks that `numworks.js` signs in, retries, re-signs in and fills the cache.
2. `tools/test-fixes.mjs`: regression tests for the code in `public/lib` (layout parsing, slot detection, update
   element selection, storage, and so on).
3. `tools/test-gate.mjs`: the model and firmware gate (N0100 refusal, outdated N0110/N0115, official-software
   checks).
4. `tools/check-i18n.mjs`: every language has the same keys and placeholders.

None of them needs a calculator or a real account. `npm run check-i18n` runs only the last one.

## Command-line tools (need a calculator and `npm install`)
| Command | Does |
|---|---|
| `node tools/probe.mjs [--dump apps.bin]` | Memories, software, apps. Read only. |
| `node tools/files.mjs [storage.bin]` | The calculator's files. Read only. |
| `node tools/install.mjs --compare app.nwa` | Links an app where the first one sits and compares with the calculator. |
| `node tools/install.mjs [--keep] [--nwagra] [--write] a.nwa ...` | Plans an install; only `--write` flashes. |

Without `--write`, `install.mjs` writes nothing. Only run `--write` on a calculator you are willing to flash.

## Mock mode
`node tools/dump-mock.mjs` and `node tools/make-mock-firmware.mjs` save a copy of a calculator and a firmware into
`public/dev/mock/` (git-ignored). Then <http://localhost:8642/?mock> runs the page against a pretend N0120 that
writes to memory only. Useful to watch an update end to end without hardware.

## Test mode (no USB at all)
Without `NODE_ENV=production`:
- `/?debug` exposes state on `window.nwaDebug`.
- `/?debug&simulate=n0100` shows the N0100 refusal.
- `/?debug&simulate=n0110-old` and `n0115-old` simulate an outdated calculator; confirming only moves a progress
  bar.

A striped badge shows when simulating. In production all of this answers 404 and is ignored.

## Checking a docs or code change
`npm test` after any change to `public/lib` or the server. For updates, test with `?mock` first.
