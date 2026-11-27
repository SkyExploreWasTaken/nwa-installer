# Troubleshooting

## "Address 0x... is not erasable flash" (`dfu.notErasable`)
**Where it comes from.** `Dfu.write()` in `public/lib/dfu.js` looks up every sector it is about to erase in the
memory layout the calculator reported. If an address falls outside every segment, or in a segment whose flags do not
include "erasable", it stops with this error. It is raised **before the first erase**, so nothing was changed.

**Usual causes.**
- The layout was read wrongly. The N0120's DFU string has two ranges
  (`@Flash/0x90000000/.../0x90430000/61*064Kg`), and an older reader only parsed the first, so addresses in the second
  range looked like they were not flash. Fixed by commit `0269f75` ("read every /0xADDR/ range"). If you see this
  on an old checkout, update to a version with that commit.
- The write really targets a hole or protected area: the gap between the two ranges, or a running slot's protected
  header block. The update path now filters for this (`elementsForSlot`, which raises `fw.notWritable`, a more
  specific message, before anything is erased).
- Writing outside the app area with `tools/install.mjs` or a restore of a backup from a different model.

**What to do.**
1. Read the address in the message and compare it with the DFU strings in the log (`dfuStrings` on the page, or
   `node tools/probe.mjs`).
2. If the address is in a range the string lists but the page says it is not erasable, the layout parser is the
   problem: report it with the string.
3. If it is in a hole, the firmware or backup is for a different layout; do not force it.

## The wrong-slot guard (`fw.wrongSlot`)
Message: "The firmware's writable part is for slot X, but the calculator runs from slot Y: stopping".

This is the last check before the update writes anything. It exists to make it impossible to overwrite the software
that is running. It trips when the slot of the elements chosen for writing is not exactly one slot, or equals the
running slot.

**Usual causes.**
- The running slot was misdetected. Slot comes from the kernel header address (commit `8aadc7e`); on Epsilon 26 the
  userland header is below the app area even when running from B, so deciding by it was wrong.
- The firmware file has parts for both slots, or only for the running one. `elementsForSlot` already keeps only the
  other slot's parts; the guard is a second line of defence.

**What to do.** Nothing was written. Check the log lines "Firmware parts: ..." (each part and its slot) and
"the calculator runs from slot ...". Reconnect and retry once. If it repeats, keep the log: it means the code and the
calculator disagree about the slot and the guard has done its job.

## Related update messages
| Message | Meaning | Action |
|---|---|---|
| `fw.nothing` | The firmware has no part for the target slot | Pick another version |
| `fw.notWritable` | A part is not in erasable and writable memory | Stops before erasing; share the address |
| `fw.check` | Read-back did not match | The running slot is untouched; retry |
| `fw.cachePending` | The server has not downloaded that firmware yet | Wait a minute, retry |
| `nw.noAccount` / `nw.badLogin` | No account file / wrong credentials | See [config](config.md) |
| "did not come back by itself" | The calculator did not reappear within 90 seconds | Connect again |

## The `.bin` backups
- **Where they go.** They are normal browser downloads, named `numworks-files-<timestamp>.bin` (files area) and
  `numworks-apps-<0xADDR>-<timestamp>.bin` (app area). Look in your browser's download folder.
- **They are git-ignored** (`*.bin`). Do not commit them: they can hold your scripts.
- **No download appeared.** The browser may have blocked multiple downloads. Allow downloads for `localhost`, then
  run **Back up files** by hand before updating. The update downloads the files backup before it writes anything,
  so if it fails there, the calculator was not changed.
- **"did not fit back" / "could not be put back (over 64 KB)".** The update succeeded, but some scripts were not
  restored. They are in the files `.bin`; the page tells you which.
- **Restore says "not an app area backup", "other area" or "doesn't fit".** The file is not an app-area backup, was
  taken at a different app-area address (different model or Epsilon version), or is bigger than this calculator's app
  area. Only restore a backup taken on the same model and software generation.
- **A backup is not an undo for firmware.** The app and files backups never contain the software slots.

## Other common problems
- **Connect fails or hangs.** Close other WebUSB users, unplug, replug, unlock the calculator, and use Chrome or
  Edge on `localhost`.
- **"unofficial software".** The calculator runs Upsilon, Omega or a third-party build. Reinstall official Epsilon
  from NumWorks first.
- **N0100.** Refused: no external flash, nothing to install apps into.
- **Nwagra unavailable.** The calculator runs from slot B (update once to land on A) or the app area already
  reaches slot B.
- **No firmware listed.** No account file, the account was refused, or the first hourly check has not finished.
  `GET /api/status` and the server log show which.
- **403 from the server.** The `Host` header was not `localhost`/`127.0.0.1`/in `ALLOWED_HOSTS`.
