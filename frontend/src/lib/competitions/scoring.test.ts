// The wash rule, tested as the claim it is: a competitor trading with themselves
// must not climb.

import { describe, it, expect } from 'vitest';
import {
  PNL_SCORING,
  RESISTANCE_LIMITS,
  RESISTANCE_RULE,
  WASH_WINDOW_SECONDS,
  scoreSeason,
  washedIndices,
} from './scoring';
import type { Season } from './season';
import type { IndexedSwap } from '../indexer/queries';

const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const WASHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HONEST = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const T0 = 1_780_000_000;

const season: Season = {
  id: 'test',
  name: 'Test season',
  startsAt: T0 - 86_400,
  endsAt: T0 + 86_400,
  quoteToken: QUOTE,
  blurb: 'test',
};

let seq = 0;
function swap(over: Partial<IndexedSwap> = {}): IndexedSwap {
  seq += 1;
  return {
    id: `s${seq}`,
    user: WASHER,
    tokenIn: QUOTE,
    tokenOut: TOKEN,
    amountIn: 10n ** 18n,
    fee: 0n,
    timestamp: BigInt(T0),
    txHash: `0x${'ab'.repeat(32)}`,
    ...over,
  };
}

describe('washedIndices', () => {
  it('strikes both legs of a round trip inside the window', () => {
    const rows = [
      swap({ timestamp: BigInt(T0) }),
      swap({ tokenIn: TOKEN, tokenOut: QUOTE, timestamp: BigInt(T0 + 60) }),
    ];
    expect([...washedIndices(rows)].sort()).toEqual([0, 1]);
  });

  it('leaves a reversal outside the window alone', () => {
    // Indistinguishable from a position genuinely held and later exited.
    const rows = [
      swap({ timestamp: BigInt(T0) }),
      swap({ tokenIn: TOKEN, tokenOut: QUOTE, timestamp: BigInt(T0 + WASH_WINDOW_SECONDS + 1) }),
    ];
    expect(washedIndices(rows).size).toBe(0);
  });

  it('consumes each leg once, so three buys and one sell strike exactly one buy', () => {
    const rows = [
      swap({ timestamp: BigInt(T0) }),
      swap({ timestamp: BigInt(T0 + 10) }),
      swap({ timestamp: BigInt(T0 + 20) }),
      swap({ tokenIn: TOKEN, tokenOut: QUOTE, timestamp: BigInt(T0 + 30) }),
    ];
    const struck = washedIndices(rows);
    expect(struck.size).toBe(2);
    // Oldest open leg is the one consumed.
    expect(struck.has(0)).toBe(true);
    expect(struck.has(3)).toBe(true);
  });

  it('does not pair two different wallets’ opposite trades', () => {
    // The rule is about one wallet reversing itself. Pairing across wallets
    // would strike ordinary two-sided trading off the board.
    const rows = [
      swap({ user: WASHER, timestamp: BigInt(T0) }),
      swap({ user: HONEST, tokenIn: TOKEN, tokenOut: QUOTE, timestamp: BigInt(T0 + 10) }),
    ];
    expect(washedIndices(rows).size).toBe(0);
  });

  it('does not pair trades on different pairs', () => {
    const rows = [
      swap({ timestamp: BigInt(T0) }),
      swap({ tokenIn: OTHER, tokenOut: QUOTE, timestamp: BigInt(T0 + 10) }),
    ];
    expect(washedIndices(rows).size).toBe(0);
  });

  it('is order-independent — the rule reads timestamps, not array position', () => {
    const rows = [
      swap({ tokenIn: TOKEN, tokenOut: QUOTE, timestamp: BigInt(T0 + 60) }),
      swap({ timestamp: BigInt(T0) }),
    ];
    expect([...washedIndices(rows)].sort()).toEqual([0, 1]);
  });
});

describe('scoreSeason', () => {
  it('a wallet that only round-trips itself scores zero and ranks below an honest one', () => {
    // THE CLAIM. The washer puts ten times the volume through the router and
    // must still finish behind a wallet that made one real buy.
    const rows: IndexedSwap[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(swap({ user: WASHER, amountIn: 10n ** 19n, timestamp: BigInt(T0 + i * 120) }));
      rows.push(
        swap({
          user: WASHER,
          tokenIn: TOKEN,
          tokenOut: QUOTE,
          amountIn: 10n ** 19n,
          timestamp: BigInt(T0 + i * 120 + 30),
        }),
      );
    }
    rows.push(swap({ user: HONEST, amountIn: 10n ** 18n, timestamp: BigInt(T0 + 5) }));

    const standings = scoreSeason(rows, { season, truncated: false });
    expect(standings.rows[0]!.wallet).toBe(HONEST);
    expect(standings.rows[0]!.countedVolume).toBe(10n ** 18n);
    const washer = standings.rows.find((r) => r.wallet === WASHER)!;
    expect(washer.countedVolume).toBe(0n);
    expect(washer.washedLegs).toBe(10);
    expect(standings.washedLegs).toBe(10);
  });

  it('counts an off-quote trade without adding it to any total', () => {
    const standings = scoreSeason(
      [swap({ tokenIn: OTHER, tokenOut: TOKEN, amountIn: 10n ** 24n, timestamp: BigInt(T0) })],
      { season, truncated: false },
    );
    expect(standings.rows[0]!.countedVolume).toBe(0n);
    expect(standings.rows[0]!.offQuoteTrades).toBe(1);
    expect(standings.rows[0]!.countedTrades).toBe(0);
  });

  it('breaks ties deterministically', () => {
    const a = swap({ user: HONEST, timestamp: BigInt(T0) });
    const b = swap({ user: WASHER, timestamp: BigInt(T0 + 1) });
    const one = scoreSeason([a, b], { season, truncated: false });
    const two = scoreSeason([b, a], { season, truncated: false });
    expect(one.rows.map((r) => r.wallet)).toEqual(two.rows.map((r) => r.wallet));
  });

  it('reports no window when nothing came back, and never a fabricated span', () => {
    const standings = scoreSeason([], { season, truncated: false });
    expect(standings.window).toBeNull();
    expect(standings.rows).toEqual([]);
    expect(standings.swapsRead).toBe(0);
  });

  it('carries truncation through — a partial page is a provisional ranking', () => {
    const standings = scoreSeason([swap()], { season, truncated: true });
    expect(standings.truncated).toBe(true);
  });

  it('has no field on a row that could be read as a profit', () => {
    const standings = scoreSeason([swap()], { season, truncated: false });
    const keys = Object.keys(standings.rows[0]!).map((k) => k.toLowerCase());
    for (const forbidden of ['pnl', 'profit', 'roi', 'return', 'returns', 'gain']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('the stated rules', () => {
  it('states the resistance AND its limits, because a claim without limits is worse', () => {
    expect(RESISTANCE_RULE).toMatch(/reversal/i);
    expect(RESISTANCE_LIMITS).toMatch(/two wallets/i);
    expect(RESISTANCE_LIMITS).toMatch(/never a counterparty/i);
    expect(PNL_SCORING).toMatch(/never what came back/i);
  });
});
