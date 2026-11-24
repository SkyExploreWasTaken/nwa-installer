// Links a .nwa (a relocatable ARM ELF) into the flat binary that goes in the calculator's flash at a given address,
// as NumWorks' installer does: GNU ld (WebAssembly, vendor/ld.*) with eadk.o and the script below, then objcopy
// to raw bytes. Every app is linked for the exact address it will sit at, so apps can't be moved once installed.

// tools = { ld: [factory, wasmBytes], oc: [factory, wasmBytes], eadk: Uint8Array }, from loadTools()
let toolsPromise = null;
export function setTools(t) { toolsPromise = Promise.resolve(t); }

export function loadTools(base = 'vendor/') {
  if (toolsPromise) return toolsPromise;
  const bytes = (u) => fetch(base + u).then((r) => { if (!r.ok) throw new Error(u + ': ' + r.status); return r.arrayBuffer(); })
    .then((b) => new Uint8Array(b));
  const script = (src) => new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = base + src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src + '. Did you run setup.js?'));
    document.head.appendChild(s);
  });
  toolsPromise = (async () => {
    const files = Promise.all([bytes('ld.wasm'), bytes('objcopy.wasm'), bytes('eadk.o')]);
    await script('ld.js');
    const ld = window.Module;
    await script('objcopy.js');
    const oc = window.Module;
    const [lw, ow, eadk] = await files;
    return { ld: [ld, lw], oc: [oc, ow], eadk };
  })().catch((e) => { toolsPromise = null; throw e; });
  return toolsPromise;
}

async function run([factory, wasm], args, files, out) {
  let log = '';
  const m = await factory({ wasmBinary: wasm, noInitialRun: true, print: (s) => { log += s + '\n'; },
    printErr: (s) => { log += s + '\n'; } });
  for (const [n, d] of Object.entries(files)) m.FS.writeFile(n, d);
  let code = 0;
  try { code = m.callMain(args); } catch (e) { if (e && typeof e.status === 'number') code = e.status; else throw e; }
  if (code) throw new Error((log.trim() || 'exit code ' + code));
  return m.FS.readFile(out);
}

// run GNU ld or objcopy on in-memory files: -> the bytes of the file `out` it wrote
export async function ld(args, files, out) { return run((await loadedTools()).ld, args, files, out); }
export async function objcopy(args, files, out) { return run((await loadedTools()).oc, args, files, out); }
async function loadedTools() {
  const t = await (toolsPromise || loadTools());
  return t;
}

const hx = (n) => '0x' + (n >>> 0).toString(16);
export function linkerScript({ flashStart, flashLength, ramStart, ramLength, trampoline }) {
  return `MEMORY {
  FLASH (rx) : ORIGIN = ${hx(flashStart)}, LENGTH = ${hx(flashLength)}
  RAM (rwx) : ORIGIN = ${hx(ramStart)}, LENGTH = ${hx(ramLength)}
}
ENTRY(_start);
_userland_trampoline_address = ${hx(trampoline)};
SECTIONS {
  .eadk_app_info ORIGIN(FLASH) : {
    LONG(0xDEC0BEBA);
    KEEP(*(.rodata.eadk_api_level))
    LONG(ADDR(.rodata.eadk_app_name) - ORIGIN(FLASH));
    LONG(SIZEOF(.rodata.eadk_app_icon));
    LONG(ADDR(.rodata.eadk_app_icon) - ORIGIN(FLASH));
    LONG(_start - ORIGIN(FLASH));
    LONG(_eadk_app_end - ORIGIN(FLASH));
    LONG(0xDEC0BEBA);
  } >FLASH
  .rodata.eadk_app_name : { KEEP(*(.rodata.eadk_app_name)) } >FLASH
  .rodata.eadk_app_icon : { KEEP(*(.rodata.eadk_app_icon)) } >FLASH
  .text : { . = ALIGN(4); *(.text) *(.text.*) } >FLASH
  .rodata : { *(.rodata) *(.rodata.*) _eadk_app_end = .; } >FLASH
  .data : {
    . = ALIGN(4);
    _data_section_start_flash = LOADADDR(.data);
    _data_section_start_ram = .;
    *(.data) *(.data.*)
    _data_section_end_ram = .;
  } >RAM AT >FLASH
  .bss : {
    . = ALIGN(4);
    _bss_section_start_ram = .;
    *(.bss) *(.bss.*)
    _bss_section_end_ram = .;
  } >RAM
  .heap : {
    _heap_start = .;
    . = (ORIGIN(RAM) + LENGTH(RAM));
    _heap_end = .;
  } >RAM
}
`;
}

// an external data file (some apps ship one) as an object the app's _eadk_external_data_* symbols point to
async function externalDataObject(t, data) {
  return run(t.oc, ['--input-target', 'binary', '--output-target', 'elf32-littlearm',
    '--rename-section', '.data=.rodata.eadk_external_data,alloc,load,readonly,data,contents',
    '--redefine-sym', '_binary_input_dat_start=_eadk_external_data_start',
    '--redefine-sym', '_binary_input_dat_size=_eadk_external_data_size',
    '--strip-symbol', '_binary_input_dat_end', 'input.dat', 'output.dat'], { 'input.dat': data }, 'output.dat');
}

// -> Uint8Array: the app's bytes for flash at mem.flashStart
export async function linkApp(nwa, mem, externalData) {
  const t = await toolsPromise;
  if (!t) throw new Error('Linker not loaded');
  const args = ['--script', 'linker.ld', '--gc-sections', '--allow-multiple-definition', 'eadk.o', 'app.nwa'];
  const files = { 'linker.ld': linkerScript(mem), 'app.nwa': nwa, 'eadk.o': t.eadk };
  if (externalData) { files['extra-data.o'] = await externalDataObject(t, externalData); args.push('extra-data.o'); }
  args.push('--output', 'out.elf');
  const elf = await run(t.ld, args, files, 'out.elf');
  return run(t.oc, ['--output-target', 'binary', 'in.elf', 'out.bin'], { 'in.elf': elf }, 'out.bin');
}

// the app's name and size, and whether it needs an external data file, from a trial link
export async function inspectNwa(nwa, mem, externalData) {
  try {
    const bin = await linkApp(nwa, mem, externalData);
    const v = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const nameOff = v.getUint32(8, true);
    let name = '';
    for (let i = nameOff; i < bin.length && bin[i] && name.length < 64; i++) name += String.fromCharCode(bin[i]);
    return { size: bin.length, name, needsData: false };
  } catch (e) {
    if (String(e.message).includes('_eadk_external_data')) return { size: undefined, name: '', needsData: true };
    throw e;
  }
}
