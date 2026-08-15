// Heat — Jungle Bay Island's held-time instrument.
//
// WHAT THIS IS. Heat prices HELD TIME. It cannot be bought and it cannot be rushed:
// price never enters the formula, and a fresh bag starts near zero no matter how big
// it is. Per (wallet, token):
//
//     heat_degrees = 100 · ( 1 − e^(−K · TWAB / totalSupply) ),  K = 60,  range 0–100
//
// TWAB is the wallet's time-weighted average balance for that token — continuous
// (per-event), zero-anchored (time before the wallet first held counts as zero, so
// new money ramps from 0° regardless of size), and velocity-blind (churn adds no
// warmth; only balance held across time does).
//
// island_heat is the SUM of per-token degrees across every token in the island's
// measured registry. One token caps at 100°, which is why the upper tiers are
// unreachable on a single position — Elder is earned across the culture.
//
// THE BOUNDARY (spec §"THE BOUNDARY"). The island computes judgement; the venue
// reads it. Wherever our number and the oracle disagree, THE ORACLE IS THE RULER.
// `heatDegreesFor` below exists ONLY to explain and preview the curve in the UI. No
// criteria state may ever be assigned from it. Enforcement reads the oracle.

/** Tier words. Rendered VERBATIM — never restyled, never translated into yield language. */
export type HeatTier = 'Elder' | 'Builder' | 'Resident' | 'Observer' | 'Drifter';

/** Island dials, published with the standard. Floors are on island_heat (the SUM). */
export const TIER_FLOORS: readonly { tier: HeatTier; floor: number; meaning: string }[] = [
  { tier: 'Elder',    floor: 250, meaning: 'deep multi-token held time' },
  { tier: 'Builder',  floor: 150, meaning: 'sustained standing across tokens' },
  { tier: 'Resident', floor: 80,  meaning: 'settled' },
  { tier: 'Observer', floor: 30,  meaning: 'the first threshold that counts' },
  { tier: 'Drifter',  floor: 0,   meaning: 'the cold state' },
] as const;

/** The steepness constant in the island's formula. */
export const HEAT_K = 60;

/**
 * THE AVERAGING WINDOW IS NOT PUBLISHED, AND WE DO NOT GET TO GUESS IT.
 *
 * This file used to export `TWAB_WINDOW_DAYS = 180` under the header "CONFIRMED BY THE
 * ISLAND 2026-08-07". It was not confirmed. The island said so directly in Wave 3, and
 * the decay mechanic the venue built on top of it — "the window ROLLS, warmth is not
 * banked, a wallet that sells decays out of the average" — was untrue and was rendered
 * to users on /leaderboard.
 *
 * That is the worst version of this venue's recurring defect: an unknown published as a
 * confident value, and attributed to a third party who never said it. A number nobody
 * can check is not a smaller lie than a wrong one; it is a larger one, because the
 * reader has no way in.
 *
 * WHAT THE ISLAND HAS ACTUALLY CONFIRMED — exactly three properties, no more:
 *   1. continuous            — balance at every moment, not a snapshot
 *   2. zero-anchored         — time before the first hold counts as zero
 *   3. velocity-blind        — churn earns nothing; only balance held across time
 *
 * So the surface shows HELD TIME SINCE FIRST HOLD and nothing else. No calendar, no
 * window length, no decay schedule. Exact window semantics arrive from the island when
 * they are published; until then a reproduction preview is not possible, and saying so
 * is the honest answer.
 *
 * `islandClaims.test.ts` fails if a window length or a decay mechanic reappears in any
 * user-facing source. When the island publishes the window, add the constant back and
 * delete that one guard — the three properties above stay true either way.
 */

/**
 * THE LAUNCH FLOOR, in island_heat degrees. The island has set it: 80 = Resident.
 * "Residents may plant" — the tier word carries the meaning on the door.
 *
 * ## Why this is degrees and NOT a tenure rule (read before "improving" it back)
 *
 * This venue previously gated launching on 180 days of `held_since_unix`. The island's
 * launch-gate spec retires that, in terms it repeats twice: "There is no 180-day rule
 * in your code, for any asset", and "NO token list, NO 180-day check, NO calendar,
 * anywhere in this codebase."
 *
 * The reasoning is that a tenure floor DOUBLE-COUNTS time and reads it worse than the
 * instrument does. Heat is TWAB-based and zero-anchored, so held time is already priced
 * INSIDE the number: a fresh bag reads cold and cannot buy the floor however large it
 * is, while a wallet that held through the year reads warm. A separate day-counter adds
 * no safety the curve does not already provide, and it fails the wallet that has held
 * several measured tokens deeply for five months while passing the wallet that has held
 * dust for six. The instrument IS the time rule.
 *
 * The half-year figure that motivated the old floor is ISLAND-SIDE ENROLLMENT judgment
 * ("arrivals prove half a year, births don't") and, per spec, never appears in venue
 * code. See docs/HEAT_LAUNCH_GATE.md for the full record of that reversal.
 *
 * Config, never a constant at the call site — pass it in, so the number moves without
 * touching the gate. `heatLaunchFloor()` in heatGateConfig.ts is the operator dial.
 */
export const LAUNCH_FLOOR = 80;

/**
 * THE FRESHNESS WINDOW, in days. A reading reckoned longer ago than this may not pass
 * or fail anyone — the door closes and says so. Spec §3, "Freshness law".
 */
export const GATE_MAX_AGE_DAYS = 7;

/** A single measured token's contribution to island_heat. */
export interface HeatBreakdownRow {
  tokenAddress: string;
  chain: string;
  name: string;
  symbol: string;
  degrees: number;
  firstSeenAtUnix: number | null;
  lastTransferAtUnix: number | null;
}

export interface HeatReading {
  address: string;
  /** island_heat — the SUM of per-token degrees. Not capped at 100. */
  degrees: number;
  tier: HeatTier;
  /** True only when the wallet has no heat rows at all. */
  isCold: boolean;
  /** min(first_seen_at) across held tokens, or null. */
  heldSinceUnix: number | null;
  /**
   * When the ISLAND last recalculated. THE FRESHNESS LAW: a stale ruler certifies
   * nothing, so every gate must check this and refuse to pass or fail on a stale
   * reading. Null on cold wallets — see isStale().
   */
  asOfUnix: number | null;
  tokenCount: number;
  breakdown: HeatBreakdownRow[];
  /** When OUR server read the upstream. Distinct from asOfUnix; never a substitute for it. */
  observedAt: number | null;
}

const TIER_WORDS = new Set<string>(['Elder', 'Builder', 'Resident', 'Observer', 'Drifter']);

/**
 * Is this payload a real answer, or our own outage wearing a 200?
 *
 * PURE and separately exported so "did the instrument actually speak?" is unit-testable
 * without a network. This exists because the same bug already shipped once here: a
 * throttled explorer key returned a 200 with an error body, and the app rendered it as
 * a factual claim about somebody's wallet (see useDeployerReputation's
 * explorerEnvelopeFailure). The inversion to avoid now is the mirror image — an
 * unreachable oracle must never read as `is_cold` or as a passing score.
 *
 * Returns a human-readable reason, or null when the payload is trustworthy.
 */
export function heatEnvelopeFailure(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return 'The instrument returned no reading.';
  const p = payload as Record<string, unknown>;

  if (typeof p.error === 'string' && p.error) return p.error;
  if (typeof p.degrees !== 'number' || !Number.isFinite(p.degrees)) {
    return 'The instrument returned no degrees.';
  }
  if (p.degrees < 0) return 'The instrument returned a negative reading.';
  if (typeof p.tier !== 'string' || !TIER_WORDS.has(p.tier)) {
    return 'The instrument returned an unrecognised tier.';
  }
  if (!Array.isArray(p.breakdown)) return 'The instrument returned no breakdown.';

  // A wallet with rows must say when it was reckoned. A COLD wallet legitimately has
  // no as_of (nothing has been measured), so null is only a failure when there is
  // something to have measured.
  const cold = p.is_cold === true;
  if (!cold && (typeof p.as_of_unix !== 'number' || !Number.isFinite(p.as_of_unix))) {
    return 'The instrument returned a reading with no reckoning date.';
  }
  return null;
}

/** Narrow the validated wire payload into our shape. Call only after heatEnvelopeFailure returns null. */
export function parseHeatReading(payload: unknown): HeatReading {
  const p = payload as Record<string, unknown>;
  const rows = (p.breakdown as Record<string, unknown>[]) ?? [];
  return {
    address: String(p.address ?? ''),
    degrees: Number(p.degrees),
    tier: p.tier as HeatTier,
    isCold: p.is_cold === true,
    heldSinceUnix: typeof p.held_since_unix === 'number' ? p.held_since_unix : null,
    asOfUnix: typeof p.as_of_unix === 'number' ? p.as_of_unix : null,
    tokenCount: typeof p.token_count === 'number' ? p.token_count : rows.length,
    observedAt: typeof p.observedAt === 'number' ? p.observedAt : null,
    breakdown: rows.map((b) => ({
      tokenAddress: String(b.token_address ?? ''),
      chain: String(b.chain ?? ''),
      name: String(b.name ?? ''),
      symbol: String(b.symbol ?? ''),
      degrees: typeof b.heat_degrees === 'number' ? b.heat_degrees : 0,
      firstSeenAtUnix: typeof b.first_seen_at_unix === 'number' ? b.first_seen_at_unix : null,
      lastTransferAtUnix: typeof b.last_transfer_at_unix === 'number' ? b.last_transfer_at_unix : null,
    })),
  };
}

/**
 * THE FRESHNESS LAW. A reading older than `maxAgeDays` may not pass or fail anyone.
 *
 * A cold wallet carries `asOfUnix: null` — it has no rows, so there is nothing that
 * could have gone stale. We treat that as NOT stale and let the floor comparison do
 * the work (a cold wallet is 0° and fails any positive floor on its merits, not on a
 * technicality). This reading is an ASSUMPTION pending the island's ruling; if they
 * rule the other way, flip this one branch and every caller inherits it.
 */
export function isStale(reading: HeatReading, nowUnix: number, maxAgeDays = GATE_MAX_AGE_DAYS): boolean {
  if (reading.asOfUnix === null) return false;
  return nowUnix - reading.asOfUnix > maxAgeDays * 86_400;
}

/**
 * THE THREE STATES OF THE DOOR. Exactly three, and the spec is emphatic that there are
 * exactly three — a fourth would be a verdict the instrument never gave.
 *
 *   WARM   degrees >= floor            the launch lane opens
 *   COLD   below floor                 the wallet sees its own degrees and what warmth is
 *   STALE  old reading or oracle silent honest error + retry. NEVER a fake verdict
 *
 * STALE covers "we could not ask" as well as "the answer is too old", because both are
 * the same fact from the door's side: there is no reading it is allowed to judge on.
 * They are kept apart in `reason` for the audit row, never in the state.
 */
export type GateState = 'WARM' | 'COLD' | 'STALE';

/** Machine-readable cause, one level finer than the state. Audit-only; UI renders `state`. */
export type GateReason = 'qualified' | 'below-floor' | 'stale-reading' | 'unreadable';

/**
 * One gate decision, in the shape the audit surface stores it.
 *
 * The spec names the row it wants logged — `{ address, degrees, tier, as_of, floor,
 * verdict }` — so any outcome replays against the instrument. This carries exactly
 * those, plus the state/reason split and the instant it was decided.
 */
export interface GateDecision {
  address: string;
  state: GateState;
  reason: GateReason;
  /** True ONLY for WARM. The one field a caller should branch on to allow anything. */
  qualified: boolean;
  /** The reading's degrees, or null when there was no reading to read. */
  degrees: number | null;
  tier: HeatTier | null;
  /** `as_of_unix` from the reading — the reckoning date. Null on a cold or absent reading. */
  asOfUnix: number | null;
  /** The floor this decision was taken against. Logged so a moved floor cannot rewrite history. */
  floor: number;
  /** The door's own words, shown to the wallet. */
  detail: string;
  decidedAt: number;
}

/**
 * THE GATE PRIMITIVE, pure half. `meetsHeatFloor` in launchGate.ts is the async half
 * that fetches; this is where the rule actually lives, so the rule is auditable in
 * exactly one place and testable without a network.
 *
 * FAIL-CLOSED, in this order — the absence of a positive answer denies, never merely
 * the presence of a negative one:
 *   1. no reading at all              -> STALE (we could not ask; that is not a pass)
 *   2. reading older than maxAgeDays  -> STALE (a stale ruler certifies nothing, so it
 *                                        may not pass ANYONE — including the wallet
 *                                        that would otherwise sail through)
 *   3. degrees below the floor        -> COLD (and the wallet is told its own number)
 *   4. degrees at or above the floor  -> WARM
 *
 * A COLD WALLET IS NOT STALE. A wallet with no measured holdings carries
 * `asOfUnix: null` — nothing has been reckoned, so nothing can have gone out of date.
 * It reads 0°, fails the floor on its merits, and gets the COLD state that explains
 * what warmth is. Routing it to STALE instead would tell a first-time visitor the
 * instrument was broken when it was working perfectly. (This resolves the open
 * question logged against the null `as_of_unix` on 2026-08-07.)
 */
export function gateDecision(
  address: string,
  reading: HeatReading | null,
  nowUnix: number,
  floor: number = LAUNCH_FLOOR,
  maxAgeDays: number = GATE_MAX_AGE_DAYS,
): GateDecision {
  const base = { address, floor, decidedAt: nowUnix };

  if (!reading) {
    return {
      ...base,
      state: 'STALE',
      reason: 'unreadable',
      qualified: false,
      degrees: null,
      tier: null,
      asOfUnix: null,
      detail: 'The island’s instrument is unreachable, so the door cannot read you. Nothing has been decided — try again in a moment.',
    };
  }

  const measured = { degrees: reading.degrees, tier: reading.tier, asOfUnix: reading.asOfUnix };

  if (isStale(reading, nowUnix, maxAgeDays)) {
    return {
      ...base,
      ...measured,
      state: 'STALE',
      reason: 'stale-reading',
      qualified: false,
      detail: `This reading was reckoned more than ${maxAgeDays} days ago, so it cannot pass or fail anyone. Try again once the island has re-measured.`,
    };
  }

  if (reading.degrees >= floor) {
    return {
      ...base,
      ...measured,
      state: 'WARM',
      reason: 'qualified',
      qualified: true,
      detail: `${reading.degrees.toFixed(2)}° — ${reading.tier}. The launch lane is open.`,
    };
  }

  return {
    ...base,
    ...measured,
    state: 'COLD',
    reason: 'below-floor',
    qualified: false,
    detail: `${reading.degrees.toFixed(2)}° — ${reading.tier}. The door opens at ${floor}°, and degrees are held time: they accrue by holding tokens the island measures, and they cannot be bought.`,
  };
}

/** Days of held history, or null when the wallet has none. */
export function heldDays(reading: HeatReading, nowUnix: number): number | null {
  if (reading.heldSinceUnix === null) return null;
  return Math.max(0, Math.floor((nowUnix - reading.heldSinceUnix) / 86_400));
}

/** The tier a given island_heat falls in. Mirrors the island's floors; display only. */
export function tierFor(degrees: number): HeatTier {
  for (const t of TIER_FLOORS) if (degrees >= t.floor) return t.tier;
  return 'Drifter';
}

/** The next tier up and the degrees still needed, or null at Elder. */
export function nextTier(degrees: number): { tier: HeatTier; floor: number; remaining: number } | null {
  const ascending = [...TIER_FLOORS].reverse().filter((t) => t.floor > 0);
  for (const t of ascending) {
    if (degrees < t.floor) return { tier: t.tier, floor: t.floor, remaining: t.floor - degrees };
  }
  return null;
}

/**
 * The island's curve, for EXPLAINING and PREVIEWING only.
 *
 * `share` is the wallet's TIME-WEIGHTED average balance as a fraction of total supply
 * (0–1). The spec permits a local re-implementation for previews and candidate
 * screens — and forbids assigning any criteria state from it. Never call this to
 * decide anything.
 */
export function heatDegreesFor(share: number): number {
  if (!(share > 0)) return 0;
  return 100 * (1 - Math.exp(-HEAT_K * share));
}

/**
 * Inverse of the curve: the time-weighted supply share a wallet needs to reach
 * `degrees` on ONE token. Used to render "what would this take?" in the explainer.
 * Returns null at/above the 100° asymptote, which is unreachable.
 */
export function shareForDegrees(degrees: number): number | null {
  if (degrees <= 0) return 0;
  if (degrees >= 100) return null;
  return -Math.log(1 - degrees / 100) / HEAT_K;
}
