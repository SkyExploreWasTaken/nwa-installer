# vendor/

- `ld.js`, `ld.wasm`, `objcopy.js`, `objcopy.wasm`: GNU ld and objcopy from
  [binutils 2.43](https://ftp.gnu.org/gnu/binutils/binutils-2.43.tar.xz), unmodified, built for `arm-none-eabi` as
  WebAssembly with emscripten 3.1.74 (the build from [NumPlay](https://github.com/mason363/NumPlay)'s
  `customize/ld/`). binutils is free software under the GNU General Public License, version 3 or later; its source
  is at the link above.
- `eadk.o` (not in the repository): made by `npm run setup` from NumWorks' `nwlink` npm package.
