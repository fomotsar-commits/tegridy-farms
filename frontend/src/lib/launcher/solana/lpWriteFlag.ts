// Whether /pools may offer adding and removing liquidity. Web3-free on purpose, like
// curveWriteFlag.ts: the pools page reads it before any write code is fetched.
//
// LP has its OWN switch, never the curve's (CURVE_WRITES_ENABLED is already true, so
// following it would open liquidity at merge with no owner step). Three states:
//   - 'off': nothing is offered and no write code loads. Only for a defect in our own
//     withdraw builder; the pools page then shows how to leave without this site.
//   - 'withdraw-only': the emergency state. Adding is hidden; removing still works.
//   - 'on': both.
//
// How it switches on:
//   - production build: ONLY the committed constant below. No env variable changes it.
//   - a dev server, or the named local-validator e2e build (`--mode solana-e2e`): the
//     existing VITE_SOLANA_CURVE_WRITES=1 turns a committed 'off' into 'on'. No new env
//     variable. A committed 'withdraw-only' is never raised by env.
//
// Even 'on', the write layer reads the chain before anything is offered
// (write/config.ts `readLpGate`), and every transaction is checked again on fresh reads.

import { curveWriteEnvOverridesAllowed } from './curveWriteFlag';

export type LpWriteMode = 'off' | 'withdraw-only' | 'on';

/** Ships 'off'. The owner flips it in its own one-line commit. 'withdraw-only' is the emergency state. */
export const LP_WRITES: LpWriteMode = 'off';

type Env = Record<string, unknown>;

function viteEnv(): Env {
  return import.meta.env as unknown as Env;
}

/**
 * The LP mode for this build. Read at CALL time, so a test can stub the env.
 * `committed` is a parameter only so the rules stay testable; every caller uses the default.
 */
export function lpWriteMode(env: Env = viteEnv(), committed: LpWriteMode = LP_WRITES): LpWriteMode {
  if (committed !== 'off') return committed;
  return curveWriteEnvOverridesAllowed(env) && env.VITE_SOLANA_CURVE_WRITES === '1' ? 'on' : 'off';
}
