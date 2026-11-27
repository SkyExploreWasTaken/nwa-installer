# Setup

## Requirements
- [Node.js](https://nodejs.org) (the code uses no recent-only features beyond what Node 18+ offers; it was written
  against a current release).
- Chrome or Edge: they have WebUSB. Firefox and Safari do not.
- A NumWorks calculator on official Epsilon 16 or later (N0110, N0115, N0120). The N0100 is refused.
  A calculator on older firmware (N0110/N0115 only) can be connected in a limited mode so it can be updated first
  (see `public/lib/gate.js`).
- For Epsilon updates only: a NumWorks account (see [Config and account files](config.md)).

## Install
```powershell
npm install
npm run setup
npm start
```
- `npm install` fetches `nwlink` (NumWorks' linker package, which holds `eadk.o`) and `usb` (node-usb, used only by
  the command-line tools).
- `npm run setup` (`tools/setup.js`) copies `eadk.o` out of `nwlink` into `public/vendor/eadk.o`. That file is
  NumWorks' and is not committed. It also prepares `extra/`, where you can put `.nwa` apps for the NumPlay builder.
- `npm start` runs `node server.js`, which listens on `127.0.0.1:8642`.

On Windows `serve.bat` does all three (installing and setting up only if needed) and opens the page.

## Open the page
Go to <http://localhost:8642/>. WebUSB only works on `localhost` or over https, so use that exact address. The
server refuses requests whose `Host` is not `localhost`, `127.0.0.1` or listed in `ALLOWED_HOSTS`.

## Connect
1. Plug the calculator in and unlock it.
2. Click **Connect calculator** and pick it in the browser's USB prompt.
3. The page reads the model, software version, slot and installed apps (read only).

Only one program can hold the calculator at a time. If connecting fails, close other tabs that use it (NumWorks'
own installer, for example), unplug, replug and retry.

## Another port
```powershell
node server.js 9000
```
or set `PORT`. Then open `http://localhost:9000/`.
