// The serialization library's inner module, loaded by hand in csl.ts so the build needs no
// WebAssembly plugin. Its exports are the package's; it adds the setter wasm-bindgen uses to
// hand the module its instance.
declare module '@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.js' {
  export * from '@emurgo/cardano-serialization-lib-browser';
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
