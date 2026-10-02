// Heat is Jungle Bay Island's held-time reading. The island computes every degree and
// every tier; this module parses its envelope, holds the island's tier bands and the
// launch floor, and takes the launch-gate decision on a served reading.
// Where a venue number and the oracle disagree, the oracle rules. The tier word beside
// a wallet is always the served `tier`; tierFor() only places a number on the ladder.
// No curve, formula, averaging window or decay schedule lives here (islandClaims.test.ts).

/** Tier words. Rendered VERBATIM — never restyled, never translated into yield language. */
export type HeatTier = 'Elder' | 'Builder' | 'Resident' | 'Observer' | 'Drifter';

/** The island's tier bands, highest first: the ladder's rungs, a name and a floor each, as
 *  the island's ladder prints them (memetics.wtf/heat: ELDER 800°, BUILDER 300°, RESIDENT
 *  80°, OBSERVER 30°, COLD below). Its /api/heat still serves the word Drifter under 30,
 *  so the bottom rung keeps the served word. The tier word beside a wallet is the served one. */
export const TIER_FLOORS: readonly { tier: HeatTier; floor: number }[] = [
  { tier: 'Elder',    floor: 800 },
  { tier: 'Builder',  floor: 300 },
  { tier: 'Resident', floor: 80 },
  { tier: 'Observer', floor: 30 },
  { tier: 'Drifter',  floor: 0 },
] as const;

/** The launch floor in degrees: 80, the Resident band. Residents may plant.
 *  A degrees floor, never a tenure rule. heatLaunchFloor() reads it; only a dev server may override. */
export const LAUNCH_FLOOR = 80;

/** The freshness window in days: an older reading may not pass or fail anyone. */
export const GATE_MAX_AGE_DAYS = 7;

/** One measured token's room, as the island serves it. */
export interface HeatBreakdownRow {
  tokenAddress: string;
  chain: string;
  name: string;
  symbol: string;
  degrees: number;
  firstSeenAtUnix: number | null;
  lastTransferAtUnix: number | null;
  /** The island's flag for a mint it no longer scans; HeatCard greys the row. Absent or
   *  non-boolean reads false. */
  retired: boolean;
}

export interface HeatReading {
  address: string;
  /** The wallet's heat as the island serves it, never recomputed from the rows. */
  degrees: number;
  tier: HeatTier;
  /** True only when the wallet has no heat rows at all. */
  isCold: boolean;
  /** min(first_seen_at) across held tokens, or null. */
  heldSinceUnix: number | null;
  /** When the island last reckoned. Every gate checks it (isStale); null on cold wallets. */
  asOfUnix: number | null;
  tokenCount: number;
  breakdown: HeatBreakdownRow[];
  /** When OUR server read the upstream. Distinct from asOfUnix; never a substitute for it. */
  observedAt: number | null;
  /** The flame's X handle stored bare (see normalizeXHandle), or null when unnamed. One
   *  form in memory, so handles are never compared with the @ in place. */
  xHandle: string | null;
}

const TIER_WORDS = new Set<string>(['Elder', 'Builder', 'Resident', 'Observer', 'Drifter']);

/** A real answer, or an outage wearing a 200? A reason string, or null when trustworthy.
 *  An unreachable oracle must never read as `is_cold` or as a passing score. */
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

  // A cold wallet has no as_of; a wallet with rows must carry one.
  const cold = p.is_cold === true;
  if (!cold && (typeof p.as_of_unix !== 'number' || !Number.isFinite(p.as_of_unix))) {
    return 'The instrument returned a reading with no reckoning date.';
  }
  return null;
}

/** The handle law: strip every leading @ and return the bare handle, or null. Also a
 *  security boundary: the value becomes an x.com href and a public byline, so only what
 *  X issues (1-15 of [A-Za-z0-9_]) passes. URLs, traversal and RTL overrides fail closed
 *  to an unnamed flame. */
export function normalizeXHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const bare = raw.trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? bare : null;
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
    // /api/heat serves `x_handle` (the board serves `x_username`). A missing handle is
    // an unnamed flame, not an envelope failure.
    xHandle: normalizeXHandle(p.x_handle),
    breakdown: rows.map((b) => ({
      tokenAddress: String(b.token_address ?? ''),
      chain: String(b.chain ?? ''),
      name: String(b.name ?? ''),
      symbol: String(b.symbol ?? ''),
      degrees: typeof b.heat_degrees === 'number' ? b.heat_degrees : 0,
      firstSeenAtUnix: typeof b.first_seen_at_unix === 'number' ? b.first_seen_at_unix : null,
      lastTransferAtUnix: typeof b.last_transfer_at_unix === 'number' ? b.last_transfer_at_unix : null,
      retired: b.retired === true,
    })),
  };
}

/** The freshness law: a reading older than maxAgeDays may not pass or fail anyone. A cold
 *  wallet (asOfUnix null) is never stale; it fails a positive floor on its merits. That is
 *  an assumption pending the island's ruling: flip this one branch if it rules otherwise. */
export function isStale(reading: HeatReading, nowUnix: number, maxAgeDays = GATE_MAX_AGE_DAYS): boolean {
  if (reading.asOfUnix === null) return false;
  return nowUnix - reading.asOfUnix > maxAgeDays * 86_400;
}

/** Exactly three door states. WARM: degrees at or above the floor. COLD: below it, and the
 *  wallet sees its own degrees. STALE: an old reading or a silent oracle, never a verdict;
 *  `reason` keeps those two apart for the audit row. */
export type GateState = 'WARM' | 'COLD' | 'STALE';

/** Machine-readable cause, one level finer than the state. Audit-only; UI renders `state`. */
export type GateReason = 'qualified' | 'below-floor' | 'stale-reading' | 'unreadable';

/** One gate decision, the audit row the spec asks for (address, degrees, tier, as_of,
 *  floor, verdict) plus the state/reason split and the instant it was decided. */
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

/** The gate rule, pure; meetsHeatFloor in launchGate.ts is the async half. Fail-closed, in
 *  order: no reading -> STALE; older than maxAgeDays -> STALE (passes and fails no one);
 *  below the floor -> COLD, told its own number; at or above -> WARM. A cold wallet
 *  (asOfUnix null) is COLD, not STALE: the instrument worked. */
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
      detail: 'The island’s instrument is unreachable, so the door cannot read you. Nothing has been decided. Try again in a moment.',
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
      // The wallet's own tier word, never the floor's.
      detail: `This wallet reads ${reading.degrees.toFixed(2)}° (${reading.tier}). The launch lane is open.`,
    };
  }

  return {
    ...base,
    ...measured,
    state: 'COLD',
    reason: 'below-floor',
    qualified: false,
    detail: `This wallet reads ${reading.degrees.toFixed(2)}° (${reading.tier}). The door opens at ${floor}°, and degrees are held time: they accrue by holding tokens the island measures, and they cannot be bought.`,
  };
}

/** The ladder rung a number sits on. Never the word beside a wallet: that is served. */
export function tierFor(degrees: number): HeatTier {
  for (const t of TIER_FLOORS) if (degrees >= t.floor) return t.tier;
  return 'Drifter';
}

/** The tier a floor sits exactly on, or null between rungs: the word named beside the
 *  launch floor. tierFor(123) is Resident, but no tier opens a door at 123. */
export function tierAtFloor(degrees: number): HeatTier | null {
  const tier = tierFor(degrees);
  return TIER_FLOORS.find((t) => t.tier === tier)?.floor === degrees ? tier : null;
}

/** The next tier up and the degrees still needed, or null at Elder. */
export function nextTier(degrees: number): { tier: HeatTier; floor: number; remaining: number } | null {
  const ascending = [...TIER_FLOORS].reverse().filter((t) => t.floor > 0);
  for (const t of ascending) {
    if (degrees < t.floor) return { tier: t.tier, floor: t.floor, remaining: t.floor - degrees };
  }
  return null;
}
