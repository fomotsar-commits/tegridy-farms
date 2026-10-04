// Whether /pools may offer adding and removing liquidity. Web3-free on purpose, like
// curveWriteFlag.ts: the pools page reads it before any write code is fetched.
//
// LP has its OWN switch, never the curve's: the two open and close on separate owner
// rulings (in the LP release launching is off while liquidity is on). Three states:
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

/**
 * 'on' from the LP release. Owner rulings: 2026-09-29 "public LP opens before the fork
 * review, with a disclosure"; 2026-10-01 "finish it all" for this release. Flipped in its
 * own commit. 'withdraw-only' is the emergency state; 'off' only for a withdraw-builder defect.
 */
export const LP_WRITES: LpWriteMode = 'on';

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

// ── The swap's own-pool route ────────────────────────────────────────────────
//
// Whether the main Solana swap may EXECUTE a trade through one of our own pools when
// that pool pays more than Jupiter after the same fee. Its own switch, on top of LP's:
// with it off, the swap still compares the two routes and says which pays more, and
// every trade goes through Jupiter (shadow mode).
//
// The same hardened rule as LP_WRITES above:
//   - production build: ONLY the committed constant. No env variable changes it.
//   - a dev server, or the `--mode solana-e2e` build: VITE_SOLANA_CURVE_WRITES=1 raises
//     a committed 'off' to 'on'. No new env variable. Env never lowers a committed 'on'.
//
// 'on' here is not enough by itself: the route also needs LP mode 'on', a pool program
// id and a fee env that agrees with the committed fee (lib/solana/swap/siteFee.ts
// ownPoolRouteOffered), and the builder checks all of it again on a fresh read.

export type OwnPoolRouteMode = 'off' | 'on';

/** Ships 'off'. The owner flips it in its own one-line commit (SPEC_S3 section 7). */
export const OWN_POOL_ROUTE: OwnPoolRouteMode = 'off';

/**
 * The own-pool route's switch for this build. Read at CALL time, so a test can stub the
 * env. `committed` is a parameter only so the rules stay testable; every caller uses the
 * default.
 */
export function ownPoolRouteMode(env: Env = viteEnv(), committed: OwnPoolRouteMode = OWN_POOL_ROUTE): OwnPoolRouteMode {
  if (committed === 'on') return 'on';
  return curveWriteEnvOverridesAllowed(env) && env.VITE_SOLANA_CURVE_WRITES === '1' ? 'on' : 'off';
}
