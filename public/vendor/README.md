# vendor/

- `ld.js`, `ld.wasm`, `objcopy.js`, `objcopy.wasm`: GNU ld and objcopy from
  [binutils 2.43](https://ftp.gnu.org/gnu/binutils/binutils-2.43.tar.xz), unmodified, built for `arm-none-eabi` as
  WebAssembly with emscripten 3.1.74 by [NumPlay](https://github.com/Mason363/NumPlay) (its `tools/ldwasm.sh`;
  these are the files of its `customize/ld/`). binutils is free software under the GNU General Public License,
  version 3 or later (see [LICENSE](../../LICENSE)); its source is at the link above.
- `eadk.o` (not in the repository): made by `npm run setup` from NumWorks' `nwlink` npm package. It's NumWorks'
  ("All rights reserved"), so it's taken from your own copy of nwlink and never distributed with this project.
