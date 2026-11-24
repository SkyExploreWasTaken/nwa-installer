# NWA Installer

Install `.nwa` apps on a NumWorks calculator from your browser, over USB. You don't need a NumWorks account and
nothing goes to a server: the page talks to the calculator over WebUSB and links the apps on your computer.

- Keeps the apps that are already installed and adds the new ones after them, or replaces them all
- **Nwagra** option (Enlarged Extra Apps): lets the last app run past the app area to the end of the flash, so you
  get about 6 MB instead of about 2 MB (6.5 MB on Epsilon 26)
- Backs up and restores the app area, and backs up the calculator's files
- Shows the calculator's model, software version and app space, and the apps on it with their sizes

Works in Chrome and Edge (browsers with WebUSB), with NumWorks calculators running Epsilon 16 or later. Tested on
an N0120 with Epsilon 26.4.

## Run it
You need [Node.js](https://nodejs.org) and Python 3.

```
npm install
npm run setup
npm start
```

Then open http://localhost:8642/ (on Windows, `serve.bat` does all of this and opens the page). WebUSB only works on
`localhost` or over https, so open it from that address, not as a file.

1. Plug the calculator in, unlock it, click **Connect calculator** and pick it.
2. Drop `.nwa` files in. They're installed in the order shown.
3. Choose the options, then click **Install**.

Only one tab or program can use the calculator at a time. If connecting fails, close other tabs that use it
(like NumWorks' own installer), unplug the calculator, plug it back in and try again.

## How it works
- `lib/dfu.js`: USB DFU with ST's DfuSe commands over WebUSB: read, erase, write, leave.
- `lib/calc.js`: reads the slot info the bootloader leaves at the start of RAM, then the kernel and userland headers
  (software version, app area, the apps' RAM, the trampoline address), then walks the installed apps: each starts on
  a 64 KB sector with a `0xDEC0BEBA` header.
- `lib/link.js`: a `.nwa` is an ARM object, so each app is linked for the address it will sit at, with GNU ld built
  as WebAssembly and `eadk.o`, the same way NumWorks' installer does. The result is byte-for-byte what NumWorks'
  installer writes.
- `lib/install.js`: lays the new apps out one after the other on whole sectors, adds an erased sector to end the
  list, then writes and checks it.

Keeping apps works because installed apps never move: only the space after them is written. To remove an app,
turn off **Keep the apps already installed** and install the ones you want again.

### Nwagra
The calculator lists the apps that start in its app area (0x90200000, or 0x90180000 on Epsilon 26, to
0x903F0000), but an app may run on past it. Nwagra lets the last app go on to the end of the external flash,
0x90800000. That space holds the calculator's spare copy of its software (slot B), which gets overwritten. The
calculator keeps running from slot A. The page only offers it when the calculator runs from slot A.

## Tests
`npm install` brings node-usb for these:
- `node test/probe.mjs`: the calculator's info and apps (only reads)
- `node test/install.mjs --compare app.nwa`: links app.nwa where the first app is and compares it with the calculator
- `node test/install.mjs [--keep] [--nwagra] [--write] a.nwa ...`: plans an install, and with `--write` flashes it
- `node test/dump-mock.mjs`, then http://localhost:8642/?mock: the page on a saved copy of your calculator, writing
  to memory only

## License
MIT for the installer's code. `vendor/ld.*` and `vendor/objcopy.*` are GNU binutils under the GPL (see
[vendor/README.md](vendor/README.md)). `eadk.o` is NumWorks' and isn't in this repository: `npm run setup` takes it
from their `nwlink` npm package.

Not affiliated with NumWorks.
