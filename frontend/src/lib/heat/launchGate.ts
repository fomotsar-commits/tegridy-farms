// THE SEEDLING GATE. "Any builder whose wallet clears the island's heat floor can
// launch. The floor is read live from the island's oracle in one call. No calendars,
// no token lists, no manual verification, ever."
//
// ## One primitive
//
// `meetsHeatFloor(address, { floor, maxAgeDays })` is the only gate in this codebase.
// Both rails call it, the door renders it, and the audit row is its output — so the
// rule lives in exactly one place and any outcome replays against the instrument.
// The RULE itself is `gateDecision` in heatOracle.ts (pure, no network); this module
// is the async half that reads the oracle and logs.
//
// ## What is deliberately absent, and must stay absent
//
// No token list. No 180-day check. No calendar. No human in any approval path. The
// island's spec is emphatic about all four, and the reasoning is that heat is TWAB-based
// and zero-anchored, so held time is already priced inside the number: a fresh bag reads
// cold and cannot buy the floor, a wallet that held through the year reads warm. The
// instrument IS the time rule. If you find yourself adding a day-counter here, the spec
// says you have drifted — stop and re-read it.
//
// ## ⚠️ ADVISORY, and the code must never imply otherwise
//
// Both launchers sign CLIENT-SIDE. Anyone can skip this UI and call the Doppler Airlock
// or the Meteora program directly, so this gate raises the floor on the path we control
// and proves nothing about the path we do not. Real enforcement needs an island-signed
// attestation the venue contract can verify — an open question with the island, not
// something this file can fake. Do not describe it as "enforced" anywhere a launcher
// can read it.

import { fetchHeat } from './heatClient';
import { gateDecision, type GateDecision, type HeatReading } from './heatOracle';
import { heatLaunchFloor, heatGateMaxAgeDays, isHeatGateEnabled } from './heatGateConfig';
import { recordGateDecision, type GateAuditRow } from './gateAudit';

/**
 * Thrown when the gate denies a launch.
 *
 * A PLAIN-ERROR SUBCLASS ON PURPOSE. The Solana submit path treats anything that is not
 * `ConfirmationTimeout`/`LaunchFailedOnChain` as "never broadcast, safe to retry", which
 * is exactly right for a denial: nothing was sent. Do NOT give this a `signature` field
 * and do not teach `wasBroadcast` about it.
 */
export class HeatGateDenied extends Error {
  readonly decision: GateDecision;
  /** The audit row, so the UI can quote the id a support thread will ask for. */
  readonly audit: GateAuditRow;
  constructor(decision: GateDecision, audit: GateAuditRow) {
    super(decision.detail);
    this.name = 'HeatGateDenied';
    this.decision = decision;
    this.audit = audit;
  }
}

export interface HeatGateOptions {
  /** Degrees floor. Config, never a constant at the call site. Defaults to the dial. */
  floor?: number;
  /** Refuse readings older than this many days. Defaults to the dial (7). */
  maxAgeDays?: number;
  /** Injectable clock, mirroring GateConfig's existing `now`. Unix seconds. */
  nowUnix?: number;
  /** Injectable fetch seam for tests; defaults to the real oracle client. */
  read?: (address: string) => Promise<HeatReading>;
  signal?: AbortSignal;
  /**
   * Skip writing an audit row. For the DOOR, which re-renders on every state change and
   * would otherwise fill the ring with duplicates of the same reading. The enforcing
   * call at submit always logs.
   */
  skipAudit?: boolean;
}

/** A decision plus the audit row it produced. */
export interface GateResult {
  decision: GateDecision;
  /** null only when `skipAudit` was set. */
  audit: GateAuditRow | null;
}

/**
 * THE GATE PRIMITIVE. Read the wallet's Heat live and decide whether it may plant.
 *
 * Never throws for an unreachable oracle: an unreadable instrument is a STALE decision
 * with a reason, not an exception, so a caller that wants to render the reason does not
 * need a try/catch. The only way to get a pass out of this function is for the island to
 * have answered, freshly, with degrees at or above the floor.
 *
 * ALWAYS reads fresh. A cached reading is fine to render on a dashboard, but the moment
 * a decision hangs on it we want the instrument's live answer and an `as_of_unix` we
 * fetched ourselves — not one that has been sitting in a tab for three minutes.
 */
export async function meetsHeatFloor(address: string, opts: HeatGateOptions = {}): Promise<GateResult> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const floor = opts.floor ?? heatLaunchFloor();
  const maxAgeDays = opts.maxAgeDays ?? heatGateMaxAgeDays();
  const read = opts.read ?? ((a: string) => fetchHeat(a, { signal: opts.signal, fresh: true }));

  let reading: HeatReading | null;
  try {
    reading = await read(address);
  } catch {
    // Unreachable, rate-limited, timed out, malformed — all indistinguishable to us, and
    // none of them are a pass. `gateDecision(null, …)` produces the STALE/unreadable state.
    reading = null;
  }

  const decision = gateDecision(address, reading, nowUnix, floor, maxAgeDays);
  return { decision, audit: opts.skipAudit ? null : recordGateDecision(decision) };
}

/**
 * The enforcement form: throw `HeatGateDenied` unless the wallet may launch.
 *
 * Call this BEFORE anything irreversible — before a signature is requested, before a
 * mint keypair is committed to, and on the Solana path before `sendTransaction`, so a
 * denial can never be mistaken for a broadcast that failed.
 *
 * Returns the audit row on a PASS, because `gate_decision_id` is what ties the resulting
 * birth back to the decision that permitted it.
 *
 * When the gate is dialled off (`VITE_HEAT_GATE=off`) this still READS and still LOGS —
 * it simply stops refusing. Turning the denial off must not also turn off the record of
 * what the door saw, or the reversal would destroy its own evidence.
 */
export async function assertMayLaunch(address: string, opts: HeatGateOptions = {}): Promise<GateAuditRow | null> {
  const { decision, audit } = await meetsHeatFloor(address, opts);
  if (!decision.qualified && isHeatGateEnabled()) {
    throw new HeatGateDenied(decision, audit ?? recordGateDecision(decision));
  }
  return audit;
}
