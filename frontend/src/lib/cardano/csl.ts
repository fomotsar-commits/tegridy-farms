// EMURGO's cardano-serialization-lib (CSL), loaded on demand.
//
// WHY CSL. The owner's rule is battle-tested code only. CSL is the serialization library the
// big Cardano wallets were built on (Yoroi, Nami), MIT, zero npm dependencies, no advisory on
// record (OSV, 2026-10-24). It builds and reads every transaction this rail touches, so the
// rail carries one Cardano library, not several. Pinned exactly in package.json: 15.0.3 and
// earlier silently truncated some amounts, fixed in 16.0.0.
//
// WHY BY HAND. The package is wasm-bindgen's "bundler" build, which imports its .wasm as an
// ES module and so needs a WebAssembly build plugin. Loading the inner module and the .wasm
// ourselves is a dozen lines and keeps that plugin, and its supply chain, out of the build.
//
// WHY LAZY. The .wasm is 2.8 MB. Only the Cardano swap page fetches it, on its first quote,
// and nothing in the main bundle imports this file (scripts/check-dist-graph.mjs).

import type * as CslModule from '@emurgo/cardano-serialization-lib-browser';

export type Csl = typeof CslModule;

/** The import object the .wasm was compiled against: one module, the JS glue. */
const GLUE_MODULE = './cardano_serialization_lib_bg.js';

/** The library could not be loaded: a network failure, or an old tab after a deploy. */
export class CslLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CslLoadError';
  }
}

let loading: Promise<Csl> | null = null;

/** Hands the instance to the glue and runs its start function, as the package's own entry does. */
function attach(glue: typeof import('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.js'), instance: WebAssembly.Instance): Csl {
  glue.__wbg_set_wasm(instance.exports);
  const start = instance.exports.__wbindgen_start;
  if (typeof start === 'function') (start as () => void)();
  return glue as unknown as Csl;
}

async function loadFromNetwork(): Promise<Csl> {
  const [glue, { default: wasmUrl }] = await Promise.all([
    import('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.js'),
    import('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.wasm?url'),
  ]);
  const res = await fetch(wasmUrl);
  // A deploy renames the file, and the site's SPA fallback answers a tab still holding the
  // old name with index.html and a 200. That is a failed load, never a library.
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('application/wasm')) {
    throw new CslLoadError('The Cardano library did not load. Reload the page and try again.');
  }
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), { [GLUE_MODULE]: glue as unknown as WebAssembly.ModuleImports });
  return attach(glue, instance);
}

/** The library, loaded once per page. A failed load is not cached, so a retry fetches again. */
export function loadCsl(): Promise<Csl> {
  if (!loading) {
    loading = loadFromNetwork().catch((err: unknown) => {
      loading = null;
      throw err instanceof CslLoadError ? err : new CslLoadError('The Cardano library did not load. Reload the page and try again.');
    });
  }
  return loading;
}

/** Tests: the same library, from the .wasm bytes on disk. */
export async function loadCslFromBytes(bytes: BufferSource): Promise<Csl> {
  const glue = await import('@emurgo/cardano-serialization-lib-browser/cardano_serialization_lib_bg.js');
  const { instance } = await WebAssembly.instantiate(bytes, { [GLUE_MODULE]: glue as unknown as WebAssembly.ModuleImports });
  const csl = attach(glue, instance);
  loading = Promise.resolve(csl);
  return csl;
}
