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
export function isStale(reading: HeatReading, nowUnix: number, maxAgeDays = 7): boolean {
  if (reading.asOfUnix === null) return false;
  return nowUnix - reading.asOfUnix > maxAgeDays * 86_400;
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
