# NWA Installer

Install `.nwa` apps on a NumWorks calculator from your browser, over USB. You don't need a NumWorks account, and
everything runs on your computer: the page talks to the calculator over WebUSB and links the apps itself.

- **Install apps**, keeping the ones already on the calculator (new apps go after them) or replacing them all
- **Nwagra** (Enlarged Extra Apps): lets the last app run past the app area to the end of the flash, for about
  6 MB of apps instead of about 2 MB (6.5 MB on Epsilon 26)
- **Build a NumPlay**: pick games from [NumPlay](https://github.com/Mason363/NumPlay)'s launcher and games, plus
  apps of your own as games like the others, and install it in one go
- **Update Epsilon** from NumWorks, keeping your Python scripts, and move the calculator to slot A (what Nwagra needs)
- **Back up** the app area and the calculator's files, and restore the app area
- Shows the calculator's model, software, app space and the apps on it

Works in Chrome and Edge (they have WebUSB) with calculators running Epsilon 16 or later. Tested on an N0120 with
Epsilon 26.4.

## Run it
You need [Node.js](https://nodejs.org).

```
npm install
npm run setup
npm start
```

Then open http://localhost:8642/. On Windows, `serve.bat` does all of this and opens the page. The server only
answers this computer, and WebUSB only works on `localhost` or over https, so open the page from that address.

1. Plug the calculator in, unlock it, click **Connect calculator** and pick it.
2. Drop `.nwa` files in, or **Build a NumPlay**. Apps are installed in the order shown.
3. Choose the options, then click **Install**.

Only one tab or program can use the calculator at a time. If connecting fails, close other pages that use it
(like NumWorks' own installer), unplug the calculator, plug it back in and try again.

## NumPlay builder
**Build a NumPlay** (in step 3) makes one app holding the games you pick, with
[NumPlay](https://github.com/Mason363/NumPlay)'s launcher. Search the games, sort them by popularity, name or
size, and pick as many as fit: the page shows how much space they take against what's free with your install
options (turn on Nwagra for the big games). Choose the launcher's language, its icon and name, and whether it opens
straight away or hides behind the Matrices app with a secret. **Add to the list** links it right there, the way
NumPlay Studio does, and puts it in the apps to install.

The `.nwa` apps in `extra/` (next to `server.js`) show up among the games, named after their files: that's how
FNAF Speed gets in. NumPlay's kit (its launcher's and games' objects) is fetched from NumPlay's site through the
local server and kept in `.cache/`, so the builder works offline after the first time.

## Epsilon updates
The **Calculator software** section installs NumWorks' official Epsilon, the latest one my.numworks.com offers for
your model. NumWorks only gives it to signed-in users, so `server.js` fetches it with your session, which you keep
in a file next to it. The page never sees it, the server never serves it, and `.gitignore` keeps it out of git.

1. Sign in at https://my.numworks.com in Chrome or Edge and open the Update page.
2. Press F12, open **Network**, reload, click the first request (`upgrade`) and copy the value of its `Cookie`
   request header.
3. Paste it into a new file `numworks-cookie.txt` next to `server.js`, on one line.

When the session expires, the page says so: copy a new cookie the same way.

Like NumWorks' updater, it writes the slot the calculator isn't running from, checks it, then restarts on it, so
each update moves the calculator between slot A and slot B. Nwagra needs slot A: from slot B, one update (even to
the same version) puts you on A. Your Python scripts are saved before and put back after, and a backup of all
files is downloaded first.

## How it works
```
server.js            the local server: the page, firmware downloads, NumPlay's files
numplay.js           NumPlay's kit from its site (kept in .cache/), and the apps in extra/
public/
  index.html, app.js, style.css    the page
  numplay-ui.js      the NumPlay builder
  lib/numplay.js     links a NumPlay.nwa from NumPlay's kit
  lib/dfu.js         USB DFU with ST's DfuSe commands over WebUSB: read, erase, write, restart
  lib/calc.js        the calculator's software headers and its installed apps
  lib/link.js        links a .nwa for the address it will sit at (GNU ld as WebAssembly, and eadk.o)
  lib/install.js     lays apps out after the kept ones, writes and checks them
  lib/dfufile.js     NumWorks' firmware files (.dfu)
  lib/storage.js     the calculator's files
  vendor/            GNU ld and objcopy as WebAssembly; eadk.o (made by npm run setup)
  dev/mockdfu.js     a pretend calculator for testing the page (?mock)
tools/               the same code from the command line, and setup
```

- The bootloader leaves where the running slot's kernel and userland headers are at the start of RAM. The userland
  header gives the app area, the apps' RAM and the trampoline table the apps' EADK calls jump through.
- Installed apps start on 64 KB sectors with a `0xDEC0BEBA` header, one after the other. The calculator lists them
  up to the first sector that doesn't start one.
- A `.nwa` is an ARM object, so each app is linked for the exact address it goes to, the way NumWorks' installer
  does it. The result is byte-for-byte what NumWorks' installer writes.
- Keeping apps works because installed apps never move: only the space after them is written. To remove an app,
  turn off **Keep the apps already installed** and install the ones you want again.
- Nwagra: the calculator lists the apps that start in its app area (0x90200000, or 0x90180000 on Epsilon 26, to
  0x903F0000), but an app may run on past it, to the end of the external flash (0x90800000). That space holds the
  calculator's spare copy of its software (slot B), which gets overwritten, while the calculator runs from slot A.

## Tools
With `npm install` done, these run the page's code against the plugged-in calculator:

| | |
|---|---|
| `node tools/probe.mjs [--dump apps.bin]` | the calculator's memories, software and apps (only reads) |
| `node tools/files.mjs [storage.bin]` | its files (only reads) |
| `node tools/install.mjs --compare app.nwa` | links app.nwa where the first app is and compares it with the calculator |
| `node tools/install.mjs [--keep] [--nwagra] [--write] a.nwa ...` | plans an install, and with `--write` flashes it |
| `node tools/dump-mock.mjs` and `node tools/make-mock-firmware.mjs` | save what http://localhost:8642/?mock needs: the page on a pretend copy of your calculator, writing to memory only |

## License
MIT for this installer's code. `public/vendor/ld.*` and `objcopy.*` are GNU binutils under the GPL (see
[public/vendor/README.md](public/vendor/README.md)). `eadk.o` is NumWorks' and isn't in this repository:
`npm run setup` takes it from their `nwlink` npm package. NumPlay's launcher, games and kit are
Mason Chen's ([NumPlay](https://github.com/Mason363/NumPlay), GPL-3.0); they aren't in this repository either: the
server fetches them from NumPlay's site.

Not affiliated with NumWorks.
