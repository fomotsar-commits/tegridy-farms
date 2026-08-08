// Operator dials for the Heat launch gate.
//
// Separate from `heatOracle.ts` on purpose: that module is the STANDARD (the curve,
// the tiers, the eligibility primitive) and should read the same everywhere. This
// module is OUR venue's policy about it, and policy is allowed to move without
// touching the standard.
//
// Both values are config, never constants at the call site — the island supplies the
// numbers and they must be changeable without editing the launch paths.

import { LAUNCH_MIN_HELD_DAYS } from './heatOracle';

/**
 * Whether the gate DENIES, as opposed to merely informing.
 *
 * Default ON. Operator decision 2026-08-07: "someone with at least 180 days of history
 * should be the only people that should be able to deploy", re-affirmed 2026-08-08
 * ("certification attaches at launch", "both chains will use heatscore").
 *
 * ⚠️ Turning this on narrows the funnel, and the binding constraint on this product is
 * distribution, not launch quality — there is no throughput to filter yet. That is the
 * operator's call and it has been made twice; the escape hatch exists so it can be
 * reversed by config rather than by a code change if the funnel proves it wrong.
 *
 * `VITE_HEAT_GATE` accepts 'off' to disable. Anything else (including unset) is on.
 */
export function isHeatGateEnabled(): boolean {
  const v = (import.meta.env.VITE_HEAT_GATE as string | undefined)?.trim().toLowerCase();
  return v !== 'off';
}

/**
 * The held-days floor. `VITE_HEAT_MIN_HELD_DAYS` overrides the standard's default.
 *
 * A non-numeric or negative override is IGNORED rather than obeyed: a typo in an env
 * var must not silently open the gate to everyone (`0` would pass every wallet that
 * has any history at all).
 */
export function heatMinHeldDays(): number {
  const raw = (import.meta.env.VITE_HEAT_MIN_HELD_DAYS as string | undefined)?.trim();
  if (!raw) return LAUNCH_MIN_HELD_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return LAUNCH_MIN_HELD_DAYS;
  return Math.floor(n);
}
