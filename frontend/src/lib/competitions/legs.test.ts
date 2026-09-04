// The round-trip rule, tested as the claim it is — and tested as a rule that
// belongs to no one chain.

import { describe, it, expect } from 'vitest';
import { WASH_WINDOW_SECONDS, rankLegs, washedLegIndices, type Leg } from './legs';
import { scoreSeason, swapToLeg } from './scoring';
import type { Season } from './season';
import type { IndexedSwap } from '../indexer/queries';

const PAIR = 'eth:0xpool';
const OTHER_PAIR = 'base:0xpool';
const WASHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HONEST = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// A real base58 key, deliberately mixed-case: lowercasing it produces a
// different, valid-looking, wrong address.
const SOLANA = 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5';

const T0 = 1_780_000_000;

let seq = 0;
function leg(over: Partial<Leg> = {}): Leg {
  seq += 1;
  return {
    id: `l${seq}`,
    wallet: WASHER,
    pairKey: PAIR,
    direction: 'a>b',
    amount: 1_000_000n,
    counted: true,
    at: T0,
    txHash: '0xabababababababababababababababababababababababababababababababab',
    ...over,
  };
}

describe('washedLegIndices', () => {
  it('strikes both legs of a reversal inside the window', () => {
    const legs = [leg({ at: T0 }), leg({ direction: 'b>a', at: T0 + 60 })];
    expect([...washedLegIndices(legs)].sort()).toEqual([0, 1]);
  });

  it('leaves a reversal outside the window alone', () => {
    // Indistinguishable from a position genuinely held and later exited. This is
    // also the mutation check for the queue's expiry shift: an implementation
    // that never drops stale entries pairs these two and goes red here.
    const legs = [leg({ at: T0 }), leg({ direction: 'b>a', at: T0 + WASH_WINDOW_SECONDS + 1 })];
    expect(washedLegIndices(legs).size).toBe(0);
  });

  it('honours a caller-supplied window', () => {
    const legs = [leg({ at: T0 }), leg({ direction: 'b>a', at: T0 + 600 })];
    expect(washedLegIndices(legs, 300).size).toBe(0);
    expect(washedLegIndices(legs, 900).size).toBe(2);
  });

  it('consumes each leg once, so three opens and one reverse strike exactly one', () => {
    const legs = [
      leg({ at: T0 }),
      leg({ at: T0 + 10 }),
      leg({ at: T0 + 20 }),
      leg({ direction: 'b>a', at: T0 + 30 }),
    ];
    const struck = washedLegIndices(legs);
    expect(struck.size).toBe(2);
    // Oldest open leg is the one consumed.
    expect(struck.has(0)).toBe(true);
    expect(struck.has(3)).toBe(true);
  });

  it('does not pair two different wallets', () => {
    const legs = [
      leg({ wallet: WASHER, at: T0 }),
      leg({ wallet: HONEST, direction: 'b>a', at: T0 + 10 }),
    ];
    expect(washedLegIndices(legs).size).toBe(0);
  });

  it('does not pair across pairs', () => {
    const legs = [leg({ at: T0 }), leg({ pairKey: OTHER_PAIR, direction: 'b>a', at: T0 + 10 })];
    expect(washedLegIndices(legs).size).toBe(0);
  });

  it('reads timestamps, not array position', () => {
    const legs = [leg({ direction: 'b>a', at: T0 + 60 }), leg({ at: T0 })];
    expect([...washedLegIndices(legs)].sort()).toEqual([0, 1]);
  });
});

describe('the rule never re-cases a wallet', () => {
  // THE POINT OF THIS FILE. The original rule lowercased every wallet, which is
  // right for EVM hex and CORRUPTING for base58 — two distinct Solana traders
  // can collide into one row under a lowercased key, and one of them inherits
  // the other's volume.
  it('round-trips a base58 wallet byte-identically', () => {
    const legs = [
      leg({ wallet: SOLANA, at: T0 }),
      leg({ wallet: SOLANA, direction: 'b>a', at: T0 + 60 }),
    ];
    const ranked = rankLegs(legs);
    expect(ranked.rows).toHaveLength(1);
    expect(ranked.rows[0]!.wallet).toBe(SOLANA);
    expect(ranked.rows[0]!.washedLegs).toBe(2);
  });

  it('treats a lowercased base58 key as a DIFFERENT wallet', () => {
    const legs = [
      leg({ wallet: SOLANA, at: T0 }),
      leg({ wallet: SOLANA.toLowerCase(), direction: 'b>a', at: T0 + 60 }),
    ];
    const ranked = rankLegs(legs);
    expect(ranked.rows).toHaveLength(2);
    // Two different senders, so neither is a round trip.
    expect(ranked.washedLegs).toBe(0);
  });
});

describe('rankLegs', () => {
  it('a wallet that only round-trips itself scores zero and ranks below an honest one', () => {
    const legs: Leg[] = [];
    for (let i = 0; i < 5; i += 1) {
      legs.push(leg({ wallet: WASHER, amount: 10_000_000n, at: T0 + i * 120 }));
      legs.push(
        leg({ wallet: WASHER, direction: 'b>a', amount: 10_000_000n, at: T0 + i * 120 + 30 }),
      );
    }
    legs.push(leg({ wallet: HONEST, amount: 1_000_000n, at: T0 + 5 }));

    const ranked = rankLegs(legs);
    expect(ranked.rows[0]!.wallet).toBe(HONEST);
    expect(ranked.rows[0]!.countedVolume).toBe(1_000_000n);
    const washer = ranked.rows.find((r) => r.wallet === WASHER)!;
    expect(washer.countedVolume).toBe(0n);
    expect(washer.washedLegs).toBe(10);
    expect(ranked.washedLegs).toBe(10);
  });

  it('counts an uncountable leg without adding it to any total', () => {
    const ranked = rankLegs([leg({ counted: false, amount: 999_999_999n })]);
    expect(ranked.rows[0]!.countedVolume).toBe(0n);
    expect(ranked.rows[0]!.uncountedTrades).toBe(1);
    expect(ranked.rows[0]!.countedTrades).toBe(0);
  });

  it('breaks ties deterministically, whatever order the legs arrive in', () => {
    const a = leg({ wallet: HONEST, at: T0 });
    const b = leg({ wallet: WASHER, at: T0 + 1 });
    expect(rankLegs([a, b]).rows.map((r) => r.wallet)).toEqual(
      rankLegs([b, a]).rows.map((r) => r.wallet),
    );
  });

  it('reports no window when nothing was read, and never a fabricated span', () => {
    const ranked = rankLegs([]);
    expect(ranked.window).toBeNull();
    expect(ranked.rows).toEqual([]);
    expect(ranked.legsRead).toBe(0);
  });

  it('takes the window from the legs themselves', () => {
    const ranked = rankLegs([leg({ at: T0 + 500 }), leg({ at: T0 })]);
    expect(ranked.window).toEqual({ from: T0, to: T0 + 500 });
  });

  it('carries no field that could be read as a profit', () => {
    const keys = Object.keys(rankLegs([leg()]).rows[0]!).map((k) => k.toLowerCase());
    for (const forbidden of ['pnl', 'profit', 'roi', 'return', 'returns', 'gain']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('the season adapter produces the same board as the shared rule', () => {
  // Refactor guard: scoreSeason is now a thin adapter over rankLegs, and the
  // only way to know the port did not drift is to run both and compare rows
  // field-for-field.
  const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const THIRD = '0x2222222222222222222222222222222222222222';
  const season: Season = {
    id: 'test',
    name: 'Test season',
    startsAt: T0 - 86_400,
    endsAt: T0 + 86_400,
    quoteToken: QUOTE,
    blurb: 'test',
  };

  const swaps: IndexedSwap[] = [
    { id: 's1', user: WASHER, tokenIn: QUOTE, tokenOut: TOKEN, amountIn: 1_000_000n, fee: 0n, timestamp: BigInt(T0), txHash: '0xa' },
    { id: 's2', user: WASHER, tokenIn: TOKEN, tokenOut: QUOTE, amountIn: 5n, fee: 0n, timestamp: BigInt(T0 + 60), txHash: '0xb' },
    { id: 's3', user: HONEST, tokenIn: QUOTE, tokenOut: TOKEN, amountIn: 2_000_000n, fee: 0n, timestamp: BigInt(T0 + 90), txHash: '0xc' },
    { id: 's4', user: HONEST, tokenIn: TOKEN, tokenOut: THIRD, amountIn: 7n, fee: 0n, timestamp: BigInt(T0 + 120), txHash: '0xd' },
  ];

  it('matches row for row', () => {
    const viaSeason = scoreSeason(swaps, { season, truncated: false });
    const viaLegs = rankLegs(swaps.map((s) => swapToLeg(s, season)));

    expect(viaSeason.rows).toHaveLength(viaLegs.rows.length);
    viaSeason.rows.forEach((row, i) => {
      const other = viaLegs.rows[i]!;
      expect(row.wallet).toBe(other.wallet);
      expect(row.countedVolume).toBe(other.countedVolume);
      expect(row.countedTrades).toBe(other.countedTrades);
      expect(row.washedLegs).toBe(other.washedLegs);
      expect(row.offQuoteTrades).toBe(other.uncountedTrades);
      expect(row.lastTradeAt).toBe(BigInt(other.lastTradeAt));
    });
    expect(viaSeason.swapsRead).toBe(viaLegs.legsRead);
    expect(viaSeason.washedLegs).toBe(viaLegs.washedLegs);
  });
});
