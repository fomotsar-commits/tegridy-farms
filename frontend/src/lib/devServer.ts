// Whether a Vite dev server compiled this code. NOT `import.meta.env.DEV`: Vite inlines
// DEV from NODE_ENV even in `vite build`, so a build host with NODE_ENV=development would
// ship DEV true. vite.config.ts defines __VITE_DEV_SERVER__ from the command (`vite` true,
// `vite build` false) and vitest.config.ts defines it true. A loader that defines nothing
// (a build script's own Vite server) reads false: the production rules.
// Web3-free and import-free on purpose: curveWriteFlag.ts (main bundle) imports it.

declare const __VITE_DEV_SERVER__: boolean | undefined;

/** True only for code a Vite dev server (or vitest) compiled; every build reads false. */
export function compiledByDevServer(): boolean {
  return typeof __VITE_DEV_SERVER__ !== 'undefined' && __VITE_DEV_SERVER__ === true;
}
