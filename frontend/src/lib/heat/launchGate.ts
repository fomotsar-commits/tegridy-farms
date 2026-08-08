// The Heat launch gate, applied at the moment of launching, on BOTH rails.
//
// The island's standard attaches certification AT LAUNCH (operator, 2026-08-08), and
// both chains use the same score — so this is one rule enforced in one place and
// called from two launch paths, rather than two implementations that can drift.
//
// ## What it actually asserts
//
// A TENURE floor, not a degrees floor: `LAUNCH_MIN_HELD_DAYS` days of held history.
// Degrees mix tenure with size, so a whale can out-score a long-time small holder;
// `held_since_unix` cannot be shortcut by a large bag. The reasoning lives on
// LAUNCH_MIN_HELD_DAYS in heatOracle.ts and the ordering lives in
// `launchIneligibility` — this module only fetches, delegates, and throws.
//
// ## ⚠️ ADVISORY, and the code must never imply otherwise
//
// Both launchers sign CLIENT-SIDE. Anyone can skip this UI and call the Doppler
// Airlock or the Meteora program directly, so this gate raises the floor on the path
// we control and proves nothing about the path we do not. Real enforcement needs an
// island-signed attestation the venue contract can verify — an open question with the
// island, not something this file can fake. Do not describe it as "enforced" anywhere
// a launcher can read it.
//
// ## Fail-closed
//
// Every failure denies. "We could not ask" and "you are cold" are different facts, and
// `launchIneligibility` keeps them apart in its reasons, but neither is a pass.

import { fetchHeat } from './heatClient';
import {
  launchIneligibility,
  LAUNCH_MIN_HELD_DAYS,
  type HeatReading,
  type LaunchIneligibility,
} from './heatOracle';

/**
 * Thrown when the gate denies a launch.
 *
 * A PLAIN-ERROR SUBCLASS ON PURPOSE. The Solana submit path treats anything that is
 * not `ConfirmationTimeout`/`LaunchFailedOnChain` as "never broadcast, safe to retry"
 * (`wasBroadcast`), which is exactly right for a denial: nothing was sent. Do not give
 * this a `signature` field or teach `wasBroadcast` about it.
 */
export class HeatGateDenied extends Error {
  readonly ineligibility: LaunchIneligibility;
  constructor(ineligibility: LaunchIneligibility) {
    super(ineligibility.detail);
    this.name = 'HeatGateDenied';
    this.ineligibility = ineligibility;
  }
}

export interface HeatGateOptions {
  /** Held-days floor. Config, never a constant at the call site. */
  minHeldDays?: number;
  /** Reject readings older than this. */
  maxAgeDays?: number;
  /** Injectable clock, mirroring GateConfig's existing `now`. */
  nowUnix?: number;
  /** Injectable fetch seam for tests; defaults to the real oracle client. */
  read?: (address: string) => Promise<HeatReading>;
  signal?: AbortSignal;
}

/**
 * Read the wallet's Heat and decide whether it may launch.
 *
 * Returns `null` when the wallet MAY launch, or the reason it may not. Never throws
 * for an unreachable oracle — an unreadable instrument is a DENIAL with a reason, not
 * an exception, so callers that want to render the reason do not need a try/catch.
 */
export async function checkLaunchEligibility(
  address: string,
  opts: HeatGateOptions = {},
): Promise<LaunchIneligibility | null> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const read = opts.read ?? ((a: string) => fetchHeat(a, { signal: opts.signal }));

  let reading: HeatReading | null;
  try {
    reading = await read(address);
  } catch {
    // Unreachable, rate-limited, malformed — all indistinguishable to us, and none of
    // them are a pass. `launchIneligibility(null, …)` produces the 'unreadable' reason.
    reading = null;
  }
  return launchIneligibility(reading, nowUnix, opts.minHeldDays ?? LAUNCH_MIN_HELD_DAYS, opts.maxAgeDays);
}

/**
 * The enforcement form: throw `HeatGateDenied` unless the wallet may launch.
 *
 * Call this BEFORE anything irreversible — before a signature is requested, before a
 * mint keypair is committed to, and on the Solana path before `sendTransaction`, so a
 * denial can never be mistaken for a broadcast that failed.
 */
export async function assertMayLaunch(address: string, opts: HeatGateOptions = {}): Promise<void> {
  const denial = await checkLaunchEligibility(address, opts);
  if (denial) throw new HeatGateDenied(denial);
}
