// Operator dials for the launch gate: env may override the venue's policy, read at call
// time so no caller captures a stale value. heatOracle.ts holds the island's values. A
// non-numeric, zero or negative override is ignored, never obeyed: `0` would admit all.

import { LAUNCH_FLOOR, GATE_MAX_AGE_DAYS } from './heatOracle';

function positiveNumberEnv(raw: string | undefined, fallback: number): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Denial is on unless VITE_HEAT_GATE=off; off, the door still reads and logs. */
export function isHeatGateEnabled(): boolean {
  return (import.meta.env.VITE_HEAT_GATE as string | undefined)?.trim().toLowerCase() !== 'off';
}

/** The launch floor in degrees: VITE_HEAT_LAUNCH_FLOOR, else LAUNCH_FLOOR (180, Resident). */
export function heatLaunchFloor(): number {
  return positiveNumberEnv(import.meta.env.VITE_HEAT_LAUNCH_FLOOR as string | undefined, LAUNCH_FLOOR);
}

/** The freshness window in days: VITE_HEAT_MAX_AGE_DAYS, else 7. Smaller is allowed. */
export function heatGateMaxAgeDays(): number {
  return positiveNumberEnv(import.meta.env.VITE_HEAT_MAX_AGE_DAYS as string | undefined, GATE_MAX_AGE_DAYS);
}

/** The island's certification endpoint, or null. Unset, isCertified answers false: the
 *  venue never self-declares certification (certification.ts). */
export function certificationEndpoint(): string | null {
  const raw = (import.meta.env.VITE_ISLAND_CERTIFICATION_URL as string | undefined)?.trim();
  return raw ? raw : null;
}
