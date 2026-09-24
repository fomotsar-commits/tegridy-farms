// The launch gate. meetsHeatFloor() reads a wallet's heat live, decides with gateDecision()
// and logs the row; assertMayLaunch() throws HeatGateDenied before anything is signed. The
// floor is degrees: no token list, no day count, no calendar, no human approval.
// Advisory: both rails sign client-side, so this holds only the path the venue controls,
// and nothing may call it enforced.

import { fetchHeat } from './heatClient';
import { gateDecision, type GateDecision, type HeatReading } from './heatOracle';
import { heatLaunchFloor, heatGateMaxAgeDays, isHeatGateEnabled } from './heatGateConfig';
import { recordGateDecision, type GateAuditRow } from './gateAudit';

/** Thrown when the gate denies a launch. A plain Error subclass, so the Solana submit
 *  path reads it as never broadcast: give it no `signature` field. */
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
  /** Injectable clock (unix seconds) and fetch seam, for tests. */
  nowUnix?: number;
  read?: (address: string) => Promise<HeatReading>;
  signal?: AbortSignal;
  /** Skip the audit row: the door re-renders; the enforcing call at submit always logs. */
  skipAudit?: boolean;
}

export interface GateResult {
  decision: GateDecision;
  /** null only when `skipAudit` was set. */
  audit: GateAuditRow | null;
}

/** Read the wallet's heat live, always fresh, and decide. Never throws: an unreachable
 *  oracle is a STALE decision. The only pass is a fresh answer at or above the floor. */
export async function meetsHeatFloor(address: string, opts: HeatGateOptions = {}): Promise<GateResult> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const floor = opts.floor ?? heatLaunchFloor();
  const maxAgeDays = opts.maxAgeDays ?? heatGateMaxAgeDays();
  const read = opts.read ?? ((a: string) => fetchHeat(a, { signal: opts.signal, fresh: true }));

  let reading: HeatReading | null;
  try {
    reading = await read(address);
  } catch {
    // Unreachable, throttled or malformed: none is a pass; gateDecision(null) is STALE.
    reading = null;
  }

  const decision = gateDecision(address, reading, nowUnix, floor, maxAgeDays);
  return { decision, audit: opts.skipAudit ? null : recordGateDecision(decision) };
}

/** Throw HeatGateDenied unless the wallet may launch; call before anything irreversible.
 *  Returns the audit row (gate_decision_id). Dialled off, it still reads and logs. */
export async function assertMayLaunch(address: string, opts: HeatGateOptions = {}): Promise<GateAuditRow | null> {
  const { decision, audit } = await meetsHeatFloor(address, opts);
  if (!decision.qualified && isHeatGateEnabled()) {
    throw new HeatGateDenied(decision, audit ?? recordGateDecision(decision));
  }
  return audit;
}
