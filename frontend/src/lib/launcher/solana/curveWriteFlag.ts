// Whether /curve-launch may even LOAD its write path (launch, buy, sell, graduate,
// pool swap). Web3-free on purpose: navConfig imports this, and navConfig
// is in the main bundle, so nothing here may pull in @solana/*.
//
// This is the FIRST of two gates and the weaker one. It only decides whether the
// write code is fetched. The second gate lives in the write layer
// (`write/config.ts` curveWriteConfig + readWriteGate): in a production build it
// takes the program ids from the committed constants only, requires them to equal
// the registered ids, and then reads the chain (both programs deployed, global
// config initialized and pointing at our pool program) before any action is shown.
//
// How it switches on:
//   - production build: ONLY the committed constant below. No env variable can turn
//     it on, so a dashboard setting cannot open writes ahead of the owner's flip.
//   - code a dev server compiled (src/devServerDefine.d.ts, never `import.meta.env.DEV`
//     alone, which NODE_ENV=development turns on in a build) or the named
//     local-validator e2e build (`--mode solana-e2e`): VITE_SOLANA_CURVE_WRITES=1 too.
// Any other custom build mode counts as production. `MODE === 'production'` is not
// the test, because `vite build --mode anything` would slip past it.

/**
 * OFF by the owner's decision (2026-10-02): the island has ruled the SOL lane open
 * (answer sixteen, ruling 1), and the owner switches launching on in its own one-line
 * PR after #682 ships. The ids stay the registered restart ids, so that PR is this line.
 *
 * Website release 2 (branch ship/solana-launch-on) set it ON together with those ids.
 * Even ON, the write layer still reads the chain before it offers anything
 * (write/config.ts `readWriteGate`), so a build served before the programs exist
 * shows a blocked banner with the reason, never a form that cannot work.
 */
export const CURVE_WRITES_ENABLED = false;

/** The one build mode besides a dev server that honours env overrides. */
export const CURVE_WRITES_E2E_MODE = 'solana-e2e';

type Env = Record<string, unknown>;

function viteEnv(): Env {
  return import.meta.env as unknown as Env;
}

/** Read here, not from a shared module: this file is in the main bundle, and a build folds it to false. */
function compiledByDevServer(): boolean {
  return typeof __VITE_DEV_SERVER__ !== 'undefined' && __VITE_DEV_SERVER__ === true;
}

/** True when env overrides are honoured: code a dev server compiled, or the named e2e build. */
export function curveWriteEnvOverridesAllowed(env: Env = viteEnv()): boolean {
  return (compiledByDevServer() && env.DEV === true) || env.MODE === CURVE_WRITES_E2E_MODE;
}

/**
 * Should the page load the write path at all? Read at CALL time, so a test can
 * stub the env. `committed` is a parameter only so the rules for a build with the
 * constant off stay testable once it is on; every caller uses the default.
 */
export function isCurveWriteEnabled(env: Env = viteEnv(), committed: boolean = CURVE_WRITES_ENABLED): boolean {
  if (committed) return true;
  return curveWriteEnvOverridesAllowed(env) && env.VITE_SOLANA_CURVE_WRITES === '1';
}
