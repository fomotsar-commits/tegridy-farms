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
//   - a dev server (`import.meta.env.DEV`) or the named local-validator e2e build
//     (`--mode solana-e2e`): the env flag VITE_SOLANA_CURVE_WRITES=1 as well.
// Any other custom build mode counts as production. `MODE === 'production'` is not
// the test, because `vite build --mode anything` would slip past it.

/**
 * The owner flips this to `true` in the same change that flips PROGRAM_ID and both
 * CP_SWAP program ids to the registered ids, after the mainnet deploy.
 */
export const CURVE_WRITES_ENABLED = false;

/** The one build mode besides a dev server that honours env overrides. */
export const CURVE_WRITES_E2E_MODE = 'solana-e2e';

type Env = Record<string, unknown>;

function viteEnv(): Env {
  return import.meta.env as unknown as Env;
}

/** True when env overrides are honoured: a dev server or the named e2e build. */
export function curveWriteEnvOverridesAllowed(env: Env = viteEnv()): boolean {
  return env.DEV === true || env.MODE === CURVE_WRITES_E2E_MODE;
}

/**
 * Should the page load the write path at all? Read at CALL time, so a test can
 * stub the env.
 */
export function isCurveWriteEnabled(env: Env = viteEnv()): boolean {
  if (CURVE_WRITES_ENABLED) return true;
  return curveWriteEnvOverridesAllowed(env) && env.VITE_SOLANA_CURVE_WRITES === '1';
}
