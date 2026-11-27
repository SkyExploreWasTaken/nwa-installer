# How the update works

The **Calculator software** section installs NumWorks' official Epsilon. The code is the `#fw-install` handler in
`public/app.js`, with helpers in `public/lib/calc.js`, `dfu.js`, `dfufile.js` and `storage.js`, and the server side
in `numworks.js` and `firmware-cache.js`.

## The two slots
The external flash holds two copies of the software:

| Slot | Starts at | Notes |
|---|---|---|
| A | `0x90000000` | |
| B | `0x90400000` (`SLOT_B`) | runs to the end of flash, `0x90800000` |

Like NumWorks' own updater, Nwa Toolkit **writes the slot the calculator is not running from**, checks it, then
restarts the calculator on it. So every update moves the calculator between A and B.

### How the running slot is found
`slotInfo()` in `calc.js` looks at the address of the running kernel header (read from the bootloader's slot info at
the start of RAM): at or above `SLOT_B` means slot B, otherwise slot A. (Older code used the userland header, which
is wrong on Epsilon 26 because the app area starts after both slots.)

### Why it matters for Nwagra
Nwagra lets the last app run past the app area into slot B's space, which overwrites the spare copy. It is only
allowed when the calculator runs from slot A, its kernel is below the app area, and the app area does not already
pass `SLOT_B`. Otherwise `nwagraReason` is `runsFromB`, `kernelAbove` or `appsPastB`. One update, even to the same
version, from B puts you on A.

## The layout reader
The calculator describes its memory over DFU as strings such as
`@Flash/0x90000000/08*004Kg,01*032Kg,63*064Kg/0x90430000/61*064Kg`.
`parseMemoryLayout()` in `dfu.js` turns each into segments: start, end, sector size and the readable / erasable /
writable flags (the letter after the size: `a` = 1, `b` = 2, `c` = 3 ... bits 1, 2, 4).

Notes:
- One string can hold several address ranges (`/0xADDR/list` repeated). The N0120 has two, with a hole between
  them. Each range is parsed from its own address, and the hole is not listed, so it is never writable. (Fixed in
  commit `0269f75`; before it only the first range was read.)
- `segmentFor(address)` finds the segment holding an address. Writes and erases consult it.

## Step by step
1. **Choose.** The page lists firmware kept on this computer by the server (`/api/firmware/<model>.json`): the
   latest stable and beta, and older kept versions. The target slot is the one not running.
2. **Confirm.** A dialog states the version and target slot and whether Python scripts are kept.
3. **Download** the `.dfu` from the local server (`/api/firmware/<model>.dfu?version=...&channel=...`). No contact
   with NumWorks happens at this moment; the file comes from the disk cache.
4. **Parse** it (`parseDfuFile`): a DfuSe file of elements, each an address and bytes. The log lists every part
   with its slot.
5. **Pick the writable part** (`elementsForSlot`). Only elements in the target slot are kept, none may pass that
   slot's end, and every sector of every element must be in a segment that is both erasable and writable. If not,
   `fw.nothing` or `fw.notWritable` is raised **before anything is erased**.
6. **The safety guard.** Last check: the kept elements must be for exactly one slot and that slot must not be the
   running one. Otherwise `fw.wrongSlot` stops everything ("The firmware's writable part is for slot X, but the
   calculator runs from slot Y: stopping").
7. **Back up the files** (if "keep my Python scripts" is on). The whole files area (`storageAddress`,
   `storageSize`) is read and downloaded as `numworks-files-<timestamp>.bin`. The `.py` files are parsed out to be
   put back later. A script over 64 KB cannot be restored (one record holds at most 64 KB); it stays only in the
   `.bin`, and the page says so.
8. **Write and check.** For each element, padded to a multiple of 4 with `0xFF`: erase its sectors, program it,
   read it all back and compare byte for byte. A mismatch raises `fw.check`; the calculator still runs its old
   software because the running slot was never touched.
9. **Restart on the new slot.** `leave(address)` tells the bootloader to jump to the new slot. The page waits up
   to 90 seconds for the calculator to reappear (matched by serial number), then reconnects.
10. **Put scripts back.** Scripts missing from the new files area are written with `buildStorage`. If they do not
    fit, the page tells you they are in the `.bin` backup.

## Backups
| File | Made by | Contains |
|---|---|---|
| `numworks-files-<stamp>.bin` | Back up files, and each update that keeps scripts | The calculator's files area (Python scripts, saves) |
| `numworks-apps-<0xADDR>-<stamp>.bin` | Back up apps | The whole app area |

Both are plain browser downloads. `*.bin` is git-ignored. **Restore** writes an app-area backup back: it checks
the file starts an app (or is all `0xFF`), that its address matches this calculator's app area, and that it fits,
then asks before overwriting. The files backup has no restore button; to recover scripts from it, copy them back
manually (it is in the calculator's storage format, which `lib/storage.js` can read).

## What is never touched
- The running slot.
- Anything outside memory the layout calls erasable and writable.
- The N0100 (refused) and calculators that are not official Epsilon (`lib/official.js` refuses third-party,
  Upsilon and Omega builds).
