# Nwa Toolkit documentation

Nwa Toolkit installs `.nwa` apps on a NumWorks calculator from Chrome or Edge over WebUSB, and can update the
calculator's Epsilon software. These pages go deeper than the [README](../README.md).

| Page | What it covers |
|---|---|
| [Setup](setup.md) | Requirements, install, first run, first connection |
| [How the update works](update.md) | Slot logic, the layout reader, the backups, the safety guard, step by step |
| [Config and account files](config.md) | `numworks-account.json`, `config.json`, environment variables, what is git-ignored |
| [The server](server.md) | What `server.js` serves, its API, flags and environment, the firmware cache |
| [Testing](testing.md) | `npm test`, the command-line tools, mock mode, test mode |
| [Troubleshooting](troubleshooting.md) | "Address ... is not erasable flash", the wrong-slot guard, the `.bin` backups, and more |

Everything here describes the code in this repository. Nothing in these pages needs a calculator except where it
says so.
