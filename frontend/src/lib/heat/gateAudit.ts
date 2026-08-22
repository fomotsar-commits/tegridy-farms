// THE AUDIT SURFACE. "Log every gate decision with the reading it used (address,
// degrees, tier, as_of, floor, verdict) so any outcome replays against the
// instrument." — launch-gate spec §3.
//
// ## Why this is deliberately NOT the analytics sink
//
// `lib/analytics.ts` is consent-gated, and correctly so. But the spec says EVERY
// decision is logged, and a wallet that declined analytics still deserves to be able
// to ask "what did the door read when it turned me away?" — that is the whole point of
// a door that explains itself. So this is a local, first-party record on the user's own
// device: it is not telemetry, it is never sent anywhere on its own, and the only part
// of it that ever leaves is the row ID, which rides a birth notify as `gate_decision_id`
// so the island can tie a token back to the decision that let it exist.
//
// ## Replayable means the ROW carries its own inputs
//
// Not a reference to the current floor, or to the current reading — the values as they
// were AT the decision. A floor that moves next week must not silently rewrite what
// last week's door was measuring against.

import type { GateDecision, HeatTier, GateState, GateReason } from './heatOracle';

/**
 * One logged decision, in the spec's own field names.
 *
 * snake_case on purpose: this row is the shape that crosses a boundary (it is quoted
 * in support threads, and its `id` is `gate_decision_id` on the wire to the island).
 * Matching the spec's spelling exactly means nobody has to translate it in their head.
 */
export interface GateAuditRow {
  /** `gate_decision_id`. Opaque, stable, and unique per decision. */
  id: string;
  address: string;
  /** null when the instrument could not be read at all — never 0, which is a real score. */
  degrees: number | null;
  tier: HeatTier | null;
  /** The reading's reckoning date. Null on a cold or absent reading. */
  as_of: number | null;
  floor: number;
  verdict: GateState;
  reason: GateReason;
  /** Unix seconds. When the door decided, not when the island reckoned. */
  decided_at: number;
}

const STORAGE_KEY = 'tegridy.heat.gate.audit.v1';

/**
 * Ring cap. Large enough that a session's worth of decisions is all there; small enough
 * that it can never grow into a storage-quota failure on a shared origin.
 */
const MAX_ROWS = 200;

/** localStorage, or null in SSR/tests/hostile-privacy modes. Never throws. */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * A unique row id.
 *
 * `crypto.randomUUID` where available. The fallback is NOT security-sensitive — this id
 * authenticates nothing, it only has to not collide with the other rows in one browser —
 * so a timestamp plus randomness is sufficient and needs no polyfill.
 */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `gd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The read, with its own failure told apart from its own emptiness.
 *
 * `readGateAudit()` collapses every outcome to `[]`, which is right for a caller that
 * only wants rows — and wrong for a surface that RENDERS the result, because "no
 * decision has been recorded" and "this browser will not let the page keep a record"
 * are different facts and an empty list shown for both reads as "you were never
 * denied". Any UI over this ring must branch on `kind`, never on `rows.length` alone.
 *
 * `dropped` counts entries that were in the blob and failed the shape check. Nonzero
 * means the record on screen is INCOMPLETE, which the reader is entitled to know.
 */
const VERDICTS = new Set<string>(['WARM', 'COLD', 'STALE']);
const REASONS = new Set<string>(['qualified', 'below-floor', 'stale-reading', 'unreadable']);
const TIERS = new Set<string>(['Elder', 'Builder', 'Resident', 'Observer', 'Drifter']);

/** A number, or the null that means "the instrument never gave one". Never NaN, never a string. */
function optionalNumber(v: unknown): boolean {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * Shape-check a row rather than trusting the blob.
 *
 * This is USER-WRITABLE storage on a shared origin: anything can be in it, including a
 * row half-written by a tab that was closed mid-`setItem`. The check covers every field
 * the render path dereferences — not just the identifying two — because the ones that
 * are easy to skip are the ones that crash it: `new Date(undefined * 1000)` throws on
 * `toISOString`, and a missing `floor` renders as the word "undefined" next to a real
 * degrees figure, which is worse than dropping the row. A row that fails here is
 * COUNTED, so the surface can say its list is incomplete instead of quietly shortening.
 */
function isGateAuditRow(r: unknown): r is GateAuditRow {
  if (!r || typeof r !== 'object') return false;
  const row = r as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.address === 'string' &&
    optionalNumber(row.degrees) &&
    (row.tier === null || (typeof row.tier === 'string' && TIERS.has(row.tier))) &&
    optionalNumber(row.as_of) &&
    typeof row.floor === 'number' &&
    Number.isFinite(row.floor) &&
    typeof row.verdict === 'string' &&
    VERDICTS.has(row.verdict) &&
    typeof row.reason === 'string' &&
    REASONS.has(row.reason) &&
    typeof row.decided_at === 'number' &&
    Number.isFinite(row.decided_at)
  );
}

export type GateAuditRead =
  | { kind: 'ok'; rows: GateAuditRow[]; dropped: number }
  /** No storage at all — private mode, blocked site data, or SSR. */
  | { kind: 'unavailable' }
  /** Storage answered, with something that is not this ring. */
  | { kind: 'unreadable' };

export function readGateAuditState(): GateAuditRead {
  const s = store();
  if (!s) return { kind: 'unavailable' };

  let raw: string | null;
  try {
    raw = s.getItem(STORAGE_KEY);
  } catch {
    return { kind: 'unavailable' };
  }
  if (!raw) return { kind: 'ok', rows: [], dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!Array.isArray(parsed)) return { kind: 'unreadable' };

  const rows = parsed.filter(isGateAuditRow);
  return { kind: 'ok', rows, dropped: parsed.length - rows.length };
}

/** Every logged decision, newest first. Returns [] rather than throwing on bad storage. */
export function readGateAudit(): GateAuditRow[] {
  const state = readGateAuditState();
  return state.kind === 'ok' ? state.rows : [];
}

/**
 * Do two addresses name the same wallet, for the purpose of filtering this ring?
 *
 * EVM hex is case-insensitive (EIP-55 checksumming is a checksum, not an identity), so
 * a row written from a checksummed string must still match a lower-cased connection.
 * Solana base58 is case-SIGNIFICANT and folding it would merge distinct wallets — so
 * the fold applies to `0x…` only. Mirrors the same split in heatClient's cache key.
 */
export function isSameAuditAddress(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  const hex = /^0x[a-fA-F0-9]{40}$/;
  return hex.test(x) && hex.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Look one decision up by its `gate_decision_id`. */
export function findGateDecision(id: string): GateAuditRow | null {
  return readGateAudit().find((r) => r.id === id) ?? null;
}

/**
 * Log a decision and return the row, whose `id` is the `gate_decision_id`.
 *
 * ALWAYS returns a row, even when storage is unavailable. A private-mode browser must
 * still be able to launch: losing the local copy of the audit trail is a degraded
 * record, not a reason to refuse someone the door already passed. The id is still
 * generated and still travels with the birth, and the island's own enrollment plus the
 * chain remain the backfill truth.
 */
export function recordGateDecision(decision: GateDecision): GateAuditRow {
  const row: GateAuditRow = {
    id: newId(),
    address: decision.address,
    degrees: decision.degrees,
    tier: decision.tier,
    as_of: decision.asOfUnix,
    floor: decision.floor,
    verdict: decision.state,
    reason: decision.reason,
    decided_at: decision.decidedAt,
  };

  const s = store();
  if (!s) return row;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify([row, ...readGateAudit()].slice(0, MAX_ROWS)));
  } catch {
    // Quota exceeded or storage disabled mid-session. Same rule as above: the decision
    // stands, the local copy is what is lost.
  }
  return row;
}

/** Wipe the local audit trail. Ops/testing only. */
export function clearGateAudit(): void {
  try {
    store()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
