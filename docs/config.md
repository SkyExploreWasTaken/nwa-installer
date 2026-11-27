# Config and account files

All three live next to `server.js` and are listed in `.gitignore`.

## `numworks-account.json`
Copy `numworks-account.example.json` and fill it in:
```json
{ "email": "you@example.com", "password": "your my.numworks.com password" }
```
- Needed only for downloading NumWorks' official firmware. Installing apps works without it.
- NumWorks gives firmware only to signed-in users, so `numworks.js` signs in to `https://my.numworks.com` (the
  Rails sign-in form, with its CSRF token), keeps the cookies in memory, and signs in again when the session ends.
- The server never serves this file (it is on the `PRIVATE` list in `server.js`), and the page never sees the
  password. `GET /api/status` only says whether an account was found.
- Errors: not valid JSON (`nw.badJson`, only the error position is shown, never the file text), missing fields
  (`nw.needsFields`), no file (`nw.noAccount`), wrong credentials (`nw.badLogin`).
- An old `numworks-cookie.txt` is also ignored by git; it is no longer used.
- Use a throwaway password you do not reuse if you can. The file is plain text.

## `config.json` (optional custom font)
Copy `config.example.json`:
```json
{ "fontStylesheet": "https://fonts.googleapis.com/css2?family=Inter&display=swap",
  "fontFamily": "Inter, sans-serif",
  "fontOrigins": ["https://fonts.gstatic.com"] }
```
- `fontStylesheet`: an `https://` CSS URL. Its origin is added to the Content-Security-Policy `style-src` and
  `font-src`.
- `fontFamily`: a CSS family (letters, digits, spaces, commas, quotes, `-`, `_`).
- `fontOrigins`: extra `https://` origins the stylesheet loads fonts from.
- Missing, empty or invalid means the system font and nothing loaded from the web. A web font tells that site you
  use the page. Restart the server after changing it.

## Environment variables
| Variable | Effect |
|---|---|
| `PORT` | Port (default 8642); `node server.js <port>` also works |
| `ALLOWED_HOSTS` | Extra host names the server answers to, comma separated (for an https reverse proxy) |
| `NODE_ENV=production` | Turns off `?mock`, `?debug`, TEST MODE; `dev/` and `lib/simulate.js` answer 404 |
| `NWA_FW_SCHEDULE=0` | Turns off the hourly firmware check (used by tests) |
| `NWA_FW_CACHE` | Where firmware is kept (default `cache/firmware/`) |
| `NUMWORKS_URL`, `NUMWORKS_ACCOUNT` | Point `numworks.js` at another site or account file (used by tests) |

## Other git-ignored paths
`node_modules/`, `public/vendor/eadk.o`, `.cache/` (NumPlay kit), `extra/`, `cache/` (firmware), `public/dev/mock/`,
`*.nwa`, `*.bin`, `*.har`.
