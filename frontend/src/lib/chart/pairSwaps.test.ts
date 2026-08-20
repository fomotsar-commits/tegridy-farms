import { describe, it, expect } from 'vitest';
import { INDEXER_META_SELECTION } from '../indexer/client';
import {
  PAIR_SWAPS_QUERY,
  pairSwapRowSchema,
  pairSwapsDataSchema,
  logIndexOf,
  pairSwapsVariables,
  priceSwapPage,
  priceSwapRow,
  scaleAmount,
  type PairPricing,
  type PairSwapRow,
} from './pairSwaps';

const PAIR = '0x00000000000000000000000000000000000000aa';
const E18: PairPricing = { base: 'token0', token0Decimals: 18, token1Decimals: 18 };

function row(over: Partial<PairSwapRow> = {}): PairSwapRow {
  return {
    id: 'tx:0',
    type: 'swap',
    pair: PAIR,
    amount0In: 0n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 0n,
    timestamp: 1_700_000_000n,
    ...over,
  };
}

describe('the document', () => {
  it('asks for `_meta` so the caller can tell a synced empty page from a backfilling one', () => {
    expect(PAIR_SWAPS_QUERY).toContain(INDEXER_META_SELECTION);
  });

  it('selects every column the schema parses, and no column ponder.schema.ts lacks', () => {
    // `id` is load-bearing, not decorative: it is the only intra-block ordering
    // signal on this document (see logIndexOf), so dropping it from the
    // selection would silently make same-block candle directions unmeasured.
    for (const field of ['id', 'amount0In', 'amount1In', 'amount0Out', 'amount1Out', 'timestamp', 'type', 'pair']) {
      expect(PAIR_SWAPS_QUERY).toContain(field);
    }
    // `totalCount` makes Ponder run a second count(*) per request behind a
    // rate-limited proxy, for a number no surface here shows.
    expect(PAIR_SWAPS_QUERY).not.toContain('totalCount');
  });
});

describe('pairSwapsVariables', () => {
  it('lowercases the pair — a checksummed filter would come back as "never traded"', () => {
    const vars = pairSwapsVariables('0x00000000000000000000000000000000000000AA', 10);
    expect(vars.where.pair).toBe(PAIR);
  });

  it('restricts to swap rows, since mint and burn carry no price', () => {
    expect(pairSwapsVariables(PAIR, 10).where.type).toBe('swap');
  });

  it('sends an object where-clause, never null (a null 500s inside Ponder)', () => {
    expect(pairSwapsVariables(PAIR, 10).where).toBeTypeOf('object');
    expect(pairSwapsVariables(PAIR, 10).where).not.toBeNull();
  });

  it('clamps the page to what the client allows', () => {
    expect(pairSwapsVariables(PAIR, 100_000).limit).toBeLessThanOrEqual(100);
    expect(pairSwapsVariables(PAIR, 0).limit).toBeGreaterThanOrEqual(1);
  });
});

describe('scaleAmount', () => {
  it('keeps precision that Number() would have destroyed before the division', () => {
    // 1234.567890123456789 ETH in wei. Routing this through Number() first
    // rounds it before the divide; splitting integer and fraction does not.
    expect(scaleAmount(1_234_567_890_123_456_789_000n, 18)).toBeCloseTo(1234.567890123457, 9);
  });

  it('handles a zero-decimal token', () => {
    expect(scaleAmount(7n, 0)).toBe(7);
  });

  it('refuses a decimals value no ERC20 can have', () => {
    expect(() => scaleAmount(1n, -1)).toThrow(RangeError);
    expect(() => scaleAmount(1n, 1.5)).toThrow(RangeError);
  });
});

describe('priceSwapRow — the derivation', () => {
  it('prices a buy of the base (base out, quote in)', () => {
    const trade = priceSwapRow(row({ amount0Out: 2n * 10n ** 18n, amount1In: 10n ** 18n }), E18);
    expect(trade).toEqual({ timeSec: 1_700_000_000, price: 0.5, volume: 2 });
  });

  it('prices a sell of the base (base in, quote out) at the same scale', () => {
    const trade = priceSwapRow(row({ amount0In: 4n * 10n ** 18n, amount1Out: 10n ** 18n }), E18);
    expect(trade).toEqual({ timeSec: 1_700_000_000, price: 0.25, volume: 4 });
  });

  it('applies each leg its own decimals', () => {
    // 1 base (18dp) for 3 quote (6dp) is a price of 3, not 3e-12.
    const trade = priceSwapRow(
      row({ amount0Out: 10n ** 18n, amount1In: 3_000_000n }),
      { base: 'token0', token0Decimals: 18, token1Decimals: 6 },
    );
    expect(trade!.price).toBeCloseTo(3, 12);
  });

  it('reads the pair the other way round when token1 is the base', () => {
    // Same row, opposite orientation: the price must be the reciprocal, and the
    // volume must switch to the other leg. Getting this backwards produces a
    // chart that is plausible and wrong.
    const raw = row({ amount0Out: 2n * 10n ** 18n, amount1In: 10n ** 18n });
    const asToken1: PairPricing = { base: 'token1', token0Decimals: 18, token1Decimals: 18 };
    const trade = priceSwapRow(raw, asToken1);
    expect(trade).toEqual({ timeSec: 1_700_000_000, price: 2, volume: 1 });
  });
});

describe('priceSwapRow — what it refuses to price', () => {
  it('refuses a non-swap row', () => {
    expect(priceSwapRow(row({ type: 'mint', amount0Out: 1n, amount1In: 1n }), E18)).toBeNull();
  });

  it('refuses a row whose base leg is zero rather than carrying a price forward', () => {
    expect(priceSwapRow(row({ amount0Out: 0n, amount1In: 10n ** 18n }), E18)).toBeNull();
  });

  it('refuses a row with null legs (mint/burn shape leaking through a bad filter)', () => {
    expect(priceSwapRow(row({ amount0Out: null, amount1In: null }), E18)).toBeNull();
  });

  it('refuses a row with no counter leg', () => {
    expect(priceSwapRow(row({ amount0Out: 10n ** 18n }), E18)).toBeNull();
  });

  it('refuses a zero timestamp rather than bucketing it at the epoch', () => {
    expect(
      priceSwapRow(row({ amount0Out: 10n ** 18n, amount1In: 10n ** 18n, timestamp: 0n }), E18),
    ).toBeNull();
  });
});

describe('logIndexOf — the only intra-block clock there is', () => {
  const BLOCK = '0x' + 'ab'.repeat(32);

  it('reads the log index off a Ponder log id', () => {
    expect(logIndexOf(`${BLOCK}-0`)).toBe(0);
    expect(logIndexOf(`${BLOCK}-137`)).toBe(137);
  });

  it('reads it as a number, so 9 sorts before 10 rather than after it', () => {
    // The whole reason the suffix is parsed instead of the id being compared as
    // a string: lexicographically "10" < "9", which would reverse the two
    // trades' order inside their block.
    expect(logIndexOf(`${BLOCK}-9`)!).toBeLessThan(logIndexOf(`${BLOCK}-10`)!);
  });

  it('returns null — never 0 — for an id it does not recognise', () => {
    // 0 is a real log index. Defaulting to it would rank an unreadable row
    // first in its block and present that as measured.
    for (const id of ['', 'tx:0', BLOCK, `${BLOCK}-`, `${BLOCK}-0x1`, `${BLOCK}-1.5`, `${BLOCK}--1`]) {
      expect(logIndexOf(id), id).toBeNull();
    }
  });

  it('returns null past the safe-integer range rather than a rounded rank', () => {
    expect(logIndexOf(`${BLOCK}-99999999999999999999`)).toBeNull();
  });
});

describe('priceSwapRow — the order signal', () => {
  const legs = { amount0Out: 10n ** 18n, amount1In: 10n ** 18n };
  const BLOCK = '0x' + 'cd'.repeat(32);

  it('carries the log index through as the trade sequence', () => {
    expect(priceSwapRow(row({ ...legs, id: `${BLOCK}-42` }), E18)!.sequence).toBe(42);
  });

  it('omits the sequence entirely when the id cannot supply one', () => {
    const trade = priceSwapRow(row({ ...legs, id: 'tx:0' }), E18)!;
    expect(trade.sequence).toBeUndefined();
    expect('sequence' in trade).toBe(false);
  });
});

describe('priceSwapPage', () => {
  const data = pairSwapsDataSchema.parse({
    pairEvents: {
      items: [
        {
          id: 'a',
          type: 'swap',
          pair: PAIR,
          amount0In: '0',
          amount1In: '1000000000000000000',
          amount0Out: '1000000000000000000',
          amount1Out: '0',
          timestamp: '1700000000',
        },
        {
          id: 'b',
          type: 'mint',
          pair: PAIR,
          amount0In: null,
          amount1In: null,
          amount0Out: null,
          amount1Out: null,
          timestamp: '1700000100',
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'c' },
    },
  });

  it('counts what it could not price instead of returning a quietly shorter list', () => {
    const page = priceSwapPage(data, E18);
    expect(page.trades).toHaveLength(1);
    expect(page.unpriceable).toBe(1);
  });

  it('carries the page boundary through so the series can drop its cut bucket', () => {
    expect(priceSwapPage(data, E18).truncated).toBe(true);
  });
});

describe('the row schema', () => {
  it('accepts the nullable amount columns mint and burn rows leave empty', () => {
    const parsed = pairSwapRowSchema.parse({
      id: 'a',
      type: 'burn',
      pair: PAIR,
      amount0In: null,
      amount1In: null,
      amount0Out: null,
      amount1Out: null,
      timestamp: '1',
    });
    expect(parsed.amount0In).toBeNull();
  });

  it('rejects a uint256 that arrived as a JSON number, which would have lost precision', () => {
    expect(() =>
      pairSwapRowSchema.parse({
        id: 'a',
        type: 'swap',
        pair: PAIR,
        // Written through Number() so the literal itself is not a lint error:
        // losing precision is exactly the input under test.
        amount0In: Number('1234567890123456789'),
        amount1In: null,
        amount0Out: null,
        amount1Out: null,
        timestamp: '1',
      }),
    ).toThrow();
  });
});
