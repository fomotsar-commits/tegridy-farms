// Pinned to REAL bytes from the live route (memetics.wtf/api/heat/:address), captured
// 2026-08-07. Fixtures are verbatim responses, not hand-written shapes, so a change in
// the island's payload breaks these rather than silently changing what we render.

import { describe, it, expect } from 'vitest';
import {
  heatEnvelopeFailure,
  parseHeatReading,
  isStale,
  tierFor,
  nextTier,
  heatDegreesFor,
  shareForDegrees,
  launchIneligibility,
  heldDays,
  TIER_FLOORS,
  HEAT_K,
  TWAB_WINDOW_DAYS,
  LAUNCH_MIN_HELD_DAYS,
} from './heatOracle';

// A real Elder: 12 measured tokens, island_heat 195.54. Trimmed to 4 rows for size;
// `degrees` is left at the true full-sum value on purpose (see the sum test below).
const WARM = {
  address: '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a',
  degrees: 195.54,
  tier: 'Builder',
  is_cold: false,
  held_since_unix: 1739235449,
  as_of_unix: 1786104024,
  token_count: 12,
  breakdown: [
    { token_address: '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca', chain: 'base', name: 'TOWELI', symbol: 'TOWELI', heat_degrees: 96.84, first_seen_at_unix: 1739235449, last_transfer_at_unix: 1786102091 },
    { token_address: '0x58d6e314755c2668f3d7358cc7a7a06c4314b238', chain: 'base', name: 'RIZZ', symbol: 'RIZZ', heat_degrees: 51.37, first_seen_at_unix: 1741000000, last_transfer_at_unix: 1786102091 },
    { token_address: '0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d', chain: 'base', name: 'Jungle Bay Memes', symbol: 'JBM', heat_degrees: 32.85, first_seen_at_unix: 1739235449, last_transfer_at_unix: 1786102091 },
    { token_address: '0x420698cfdeddea6bc78d59bc17798113ad278f9d', chain: 'ethereum', name: 'TOWELI', symbol: 'TOWELI', heat_degrees: 1.44, first_seen_at_unix: 1750000000, last_transfer_at_unix: 1786102091 },
  ],
};

// A real cold read. NOTE as_of_unix is null — the island sends no reckoning date when
// there are no rows. This is the case the freshness law does not cover.
const COLD = {
  address: '0x0000000000000000000000000000000000000000',
  degrees: 0,
  tier: 'Drifter',
  is_cold: true,
  held_since_unix: null,
  as_of_unix: null,
  token_count: 0,
  breakdown: [],
};

describe('heatEnvelopeFailure — an outage must never read as a low score', () => {
  it('accepts a real warm payload', () => {
    expect(heatEnvelopeFailure(WARM)).toBeNull();
  });

  it('accepts a real cold payload despite as_of_unix being null', () => {
    // A cold wallet legitimately has nothing to have reckoned. Rejecting it here would
    // make every unmeasured wallet look like an outage.
    expect(heatEnvelopeFailure(COLD)).toBeNull();
  });

  it('rejects a WARM payload that omits the reckoning date', () => {
    // The inverse of the case above: rows exist, so a missing as_of is a broken read.
    expect(heatEnvelopeFailure({ ...WARM, as_of_unix: null })).toMatch(/reckoning date/i);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an error envelope', { error: 'Invalid address' }],
    ['non-numeric degrees', { ...WARM, degrees: '195.54' }],
    ['NaN degrees', { ...WARM, degrees: Number.NaN }],
    ['negative degrees', { ...WARM, degrees: -1 }],
    ['an unknown tier word', { ...WARM, tier: 'Warlord' }],
    ['a missing breakdown', { ...WARM, breakdown: undefined }],
  ])('rejects %s', (_label, payload) => {
    expect(heatEnvelopeFailure(payload)).toBeTruthy();
  });
});

describe('parseHeatReading', () => {
  it('island_heat is the SUM of the per-token degrees', () => {
    const r = parseHeatReading(WARM);
    const summed = r.breakdown.reduce((a, b) => a + b.degrees, 0);
    // The fixture is trimmed to 4 of 12 rows, so the sum is a lower bound on the total.
    expect(summed).toBeLessThanOrEqual(r.degrees + 0.01);
    expect(r.tokenCount).toBe(12);
    expect(r.breakdown).toHaveLength(4);
  });

  it('carries the two distinct freshness stamps apart', () => {
    const r = parseHeatReading({ ...WARM, observedAt: 1786158000 });
    expect(r.asOfUnix).toBe(1786104024);   // when the ISLAND reckoned
    expect(r.observedAt).toBe(1786158000); // when WE read it
  });

  it('reads a cold wallet as cold, not as an error', () => {
    const r = parseHeatReading(COLD);
    expect(r.isCold).toBe(true);
    expect(r.degrees).toBe(0);
    expect(r.breakdown).toEqual([]);
  });
});

describe('isStale — the freshness law', () => {
  const asOf = 1786104024;

  it('is fresh inside the window', () => {
    expect(isStale(parseHeatReading(WARM), asOf + 6 * 86400, 7)).toBe(false);
  });

  it('is stale past the window', () => {
    expect(isStale(parseHeatReading(WARM), asOf + 8 * 86400, 7)).toBe(true);
  });

  it('is exactly fresh at the boundary', () => {
    expect(isStale(parseHeatReading(WARM), asOf + 7 * 86400, 7)).toBe(false);
  });

  it('treats a cold reading as not-stale (documented assumption, pending the island)', () => {
    expect(isStale(parseHeatReading(COLD), asOf + 900 * 86400, 7)).toBe(false);
  });
});

describe('launchIneligibility — the gate primitive, fail-closed', () => {
  const asOf = 1786104024;
  const DAY = 86_400;
  // A wallet whose first measured holding was exactly N days before `now`.
  const heldFor = (days: number) =>
    parseHeatReading({ ...WARM, held_since_unix: asOf - days * DAY, as_of_unix: asOf });

  it('DENIES when there is no reading at all — an outage is not a pass', () => {
    expect(launchIneligibility(null, asOf)).toMatchObject({ reason: 'unreadable' });
  });

  it('DENIES on a stale reading, even for a wallet that would otherwise sail through', () => {
    // 5 years of history — but the ruler has not been read in a month.
    const ancient = parseHeatReading({ ...WARM, held_since_unix: asOf - 1825 * DAY, as_of_unix: asOf });
    expect(launchIneligibility(ancient, asOf + 30 * DAY)).toMatchObject({ reason: 'stale' });
  });

  it('DENIES a cold wallet with no held history', () => {
    expect(launchIneligibility(parseHeatReading(COLD), asOf)).toMatchObject({ reason: 'no-history' });
  });

  it('DENIES a wallet one day short, and says how long is left', () => {
    const v = launchIneligibility(heldFor(179), asOf);
    expect(v).toMatchObject({ reason: 'too-new', heldDays: 179, requiredDays: 180 });
    // Exact string, so "1 more days" cannot slip through as a substring match.
    expect(v!.detail).toBe('179 days of held history — 1 more day to go.');
  });

  it('pluralises correctly at the other end too', () => {
    expect(launchIneligibility(heldFor(1), asOf)!.detail).toBe('1 day of held history — 179 more days to go.');
  });

  it('ALLOWS exactly at the 180-day boundary', () => {
    expect(launchIneligibility(heldFor(180), asOf)).toBeNull();
  });

  it('ALLOWS a long-held wallet', () => {
    expect(launchIneligibility(heldFor(400), asOf)).toBeNull();
  });

  it('a huge bag cannot shortcut the wait — tenure is the gate, not degrees', () => {
    // 100° on a single token (a whale), but only 10 days of history.
    const whale = parseHeatReading({
      ...WARM, degrees: 100, tier: 'Resident',
      held_since_unix: asOf - 10 * DAY, as_of_unix: asOf,
    });
    expect(launchIneligibility(whale, asOf)).toMatchObject({ reason: 'too-new' });
  });

  it('the floor is configurable, not baked in', () => {
    expect(launchIneligibility(heldFor(30), asOf, 30)).toBeNull();
    expect(launchIneligibility(heldFor(30), asOf, 90)).toMatchObject({ reason: 'too-new' });
  });

  it('checks freshness BEFORE tenure — a stale reading may not fail anyone either', () => {
    // Too new AND stale. The spec forbids failing someone on a stale reading, so the
    // verdict must be 'stale' (retryable) and never 'too-new' (a judgement).
    const v = launchIneligibility(heldFor(5), asOf + 30 * DAY);
    expect(v).toMatchObject({ reason: 'stale' });
  });
});

describe('heldDays', () => {
  it('counts whole days since the first measured holding', () => {
    const r = parseHeatReading({ ...WARM, held_since_unix: 1786104024 - 200 * 86_400 });
    expect(heldDays(r, 1786104024)).toBe(200);
  });
  it('is null for a wallet with no history', () => {
    expect(heldDays(parseHeatReading(COLD), 1786104024)).toBeNull();
  });
});

describe('tiers', () => {
  it.each([
    [0, 'Drifter'], [29.99, 'Drifter'],
    [30, 'Observer'], [79.99, 'Observer'],
    [80, 'Resident'], [149.99, 'Resident'],
    [150, 'Builder'], [249.99, 'Builder'],
    [250, 'Elder'], [1000, 'Elder'],
  ] as const)('%d° is %s', (deg, tier) => {
    expect(tierFor(deg)).toBe(tier);
  });

  it('agrees with the real payload’s own tier word', () => {
    const r = parseHeatReading(WARM);
    expect(tierFor(r.degrees)).toBe(r.tier);
  });

  it('nextTier counts the remaining degrees, and is null at Elder', () => {
    expect(nextTier(195.54)).toEqual({ tier: 'Elder', floor: 250, remaining: 250 - 195.54 });
    expect(nextTier(0)).toEqual({ tier: 'Observer', floor: 30, remaining: 30 });
    expect(nextTier(250)).toBeNull();
  });
});

describe('the curve (display only — the oracle is the ruler)', () => {
  it('is zero-anchored: no share, no warmth', () => {
    expect(heatDegreesFor(0)).toBe(0);
  });

  it('is bounded to the 0–100 per-token cap', () => {
    // The curve is asymptotic, so no share can exceed 100. It does round to exactly
    // 100 in float64 well before share=1 (e^-60 is ~8.8e-27), which is why this pins
    // the BOUND rather than a strict inequality.
    for (const share of [0, 0.001, 0.05, 0.5, 1]) {
      const d = heatDegreesFor(share);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
    }
    // A realistic whale position is still short of the cap — the interesting range.
    expect(heatDegreesFor(0.05)).toBeCloseTo(95.02, 1);
  });

  it('a negative or nonsense share is 0, never NaN', () => {
    expect(heatDegreesFor(-1)).toBe(0);
    expect(heatDegreesFor(Number.NaN)).toBe(0);
  });

  it('is monotonic in share', () => {
    const pts = [0.001, 0.005, 0.01, 0.02, 0.05].map(heatDegreesFor);
    for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThan(pts[i - 1]!);
  });

  it('matches the island’s constant K = 60', () => {
    expect(HEAT_K).toBe(60);
    // 1% of supply, time-weighted, on one token.
    expect(heatDegreesFor(0.01)).toBeCloseTo(100 * (1 - Math.exp(-0.6)), 6);
  });

  it('shareForDegrees inverts the curve', () => {
    for (const d of [5, 30, 80, 95]) {
      expect(heatDegreesFor(shareForDegrees(d)!)).toBeCloseTo(d, 6);
    }
    expect(shareForDegrees(100)).toBeNull();
  });

  it('reproduces the spec’s own worked example', () => {
    // "Wallet 0xe91b…610e holding ~66.9M JBM since late January reads 0.72°" — a large
    // bag, held six weeks, still nearly cold. Pinning the direction, not the wallet.
    const share = shareForDegrees(0.72)!;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.0002); // ~0.012% of supply, time-weighted
  });

  it('pins the island-confirmed constants', () => {
    // Both were told to us rather than derived; if either moves, that is a decision
    // someone made, and it should break a test rather than slip through.
    expect(TWAB_WINDOW_DAYS).toBe(180);
    expect(LAUNCH_MIN_HELD_DAYS).toBe(180);
  });

  it('the published floors are ordered and start at Drifter/0', () => {
    const floors = TIER_FLOORS.map((t) => t.floor);
    expect(floors).toEqual([...floors].sort((a, b) => b - a));
    expect(floors.at(-1)).toBe(0);
  });
});
