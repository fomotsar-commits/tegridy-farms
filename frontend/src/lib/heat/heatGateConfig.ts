// Operator dials for the launch gate, read at call time so no caller captures a stale value.
// heatOracle.ts holds the island's values. A production build has no exception: it ignores
// VITE_HEAT_GATE and VITE_HEAT_LAUNCH_FLOOR (only a dev server honours them, as
// curveWriteFlag.ts does for writes), and VITE_HEAT_MAX_AGE_DAYS may only shrink the 7-day
// window. A non-numeric, zero or negative override is ignored, never obeyed.

import { LAUNCH_FLOOR, GATE_MAX_AGE_DAYS } from './heatOracle';

type Env = Record<string, unknown>;

function viteEnv(): Env {
  return import.meta.env as unknown as Env;
}

function positiveNumberEnv(raw: unknown, fallback: number): number {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** True only on a dev server (vitest counts as one). Every build mode is production. */
export function heatEnvOverridesAllowed(env: Env = viteEnv()): boolean {
  return env.DEV === true;
}

/** Denial is on; only a dev server with VITE_HEAT_GATE=off turns it off (still reads, logs). */
export function isHeatGateEnabled(env: Env = viteEnv()): boolean {
  if (!heatEnvOverridesAllowed(env)) return true;
  const raw = typeof env.VITE_HEAT_GATE === 'string' ? env.VITE_HEAT_GATE : '';
  return raw.trim().toLowerCase() !== 'off';
}

/** The launch floor in degrees: LAUNCH_FLOOR (80, Resident); a dev server may override it. */
export function heatLaunchFloor(env: Env = viteEnv()): number {
  if (!heatEnvOverridesAllowed(env)) return LAUNCH_FLOOR;
  return positiveNumberEnv(env.VITE_HEAT_LAUNCH_FLOOR, LAUNCH_FLOOR);
}

/** The freshness window in days: 7, or VITE_HEAT_MAX_AGE_DAYS when that is smaller. */
export function heatGateMaxAgeDays(env: Env = viteEnv()): number {
  return Math.min(GATE_MAX_AGE_DAYS, positiveNumberEnv(env.VITE_HEAT_MAX_AGE_DAYS, GATE_MAX_AGE_DAYS));
}

/** The island's certification endpoint, or null. Unset, isCertified answers false: the
 *  venue never self-declares certification (certification.ts). */
export function certificationEndpoint(): string | null {
  const raw = (import.meta.env.VITE_ISLAND_CERTIFICATION_URL as string | undefined)?.trim();
  return raw ? raw : null;
}
