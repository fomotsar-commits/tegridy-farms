// Operator dials for the Heat launch gate.
//
// Separate from `heatOracle.ts` on purpose: that module is the STANDARD (the curve,
// the tiers, the gate primitive) and must read the same everywhere. This module is OUR
// venue's policy about it, and policy is allowed to move without touching the standard.
//
// "Floors are config, never constants. Tier words render verbatim." — gate spec §6.8.
// Every value here is read through a function rather than exported as a constant, so a
// caller cannot capture one at module-init and drift from a redeployed dial.

import { LAUNCH_FLOOR, GATE_MAX_AGE_DAYS } from './heatOracle';

/**
 * Read a positive-number env override, or fall back.
 *
 * A non-numeric, negative or zero override is IGNORED rather than obeyed. A typo in an
 * env var must never silently open the door to everyone — and `0` would do exactly
 * that, since every wallet including a brand-new one reads `degrees >= 0`.
 */
function positiveNumberEnv(raw: string | undefined, fallback: number): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Whether the gate DENIES, as opposed to merely informing.
 *
 * Default ON. `VITE_HEAT_GATE=off` disables denial — the card and the door still render
 * the reading, they simply stop refusing. That is the reversal path if the funnel proves
 * the floor wrong, and it is config rather than a code change on purpose.
 *
 * ⚠️ Standing note on the record: a launch floor narrows a funnel whose binding
 * constraint is distribution, not launch quality. The island's spec makes the floor the
 * PITCH ("a launchpad where the door itself proves the standard"), which is the argument
 * for keeping it on. Both things are true; the dial exists so the answer can change
 * without a deploy of new logic.
 */
export function isHeatGateEnabled(): boolean {
  return (import.meta.env.VITE_HEAT_GATE as string | undefined)?.trim().toLowerCase() !== 'off';
}

/**
 * The launch floor in island_heat degrees. `VITE_HEAT_LAUNCH_FLOOR` overrides.
 * The island has set it: 80 (Resident).
 */
export function heatLaunchFloor(): number {
  return positiveNumberEnv(import.meta.env.VITE_HEAT_LAUNCH_FLOOR as string | undefined, LAUNCH_FLOOR);
}

/**
 * The freshness window in days. `VITE_HEAT_MAX_AGE_DAYS` overrides. Default 7.
 *
 * Widening this weakens the freshness law, so the same "ignore a nonsense override"
 * rule applies — but note it is NOT clamped downward: an operator who wants a stricter
 * (smaller) window may have one.
 */
export function heatGateMaxAgeDays(): number {
  return positiveNumberEnv(import.meta.env.VITE_HEAT_MAX_AGE_DAYS as string | undefined, GATE_MAX_AGE_DAYS);
}

/**
 * Where the island publishes certification state for the GARDEN lane.
 *
 * Unset today, and that is the correct state: the island's first certifications have
 * not closed. `isCertified` reads this and answers false while it is empty — the venue
 * NEVER self-declares certification. See certification.ts.
 */
export function certificationEndpoint(): string | null {
  const raw = (import.meta.env.VITE_ISLAND_CERTIFICATION_URL as string | undefined)?.trim();
  return raw ? raw : null;
}
