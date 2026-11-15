// Harvest's totals bar: one coin, one sum. Claims are added only within a coin, and a daily
// figure is passed through as its pool's reader stated it, never worked out or added up here.
import { describe, it, expect } from 'vitest';
import { harvestTally } from './tally';
import type { HarvestClaim, HarvestEarning } from './types';

const claim = (key: string, roomId: string, symbol: string, amountRaw: bigint, over: Partial<HarvestClaim> = {}): HarvestClaim =>
  ({ key, chain: 'solana', roomId, symbol, where: 'lock ladder', detail: null, amountRaw, decimals: 6, caution: null, ...over });
const earning = (roomId: string, symbol: string, over: Partial<HarvestEarning> = {}): HarvestEarning =>
  ({ key: `ladder:${roomId}`, chain: 'solana', roomId, symbol, where: 'lock ladder', decimals: 6, principalRaw: 1_000_000n, perDayRaw: 1_234n, apr: '45%', fundedToSecs: 1_800_000_000, ...over });

describe("Harvest's totals bar", () => {
  it('adds a coin’s claims together: the six locks of the owner’s screenshot come to one figure', () => {
    const six = [70_600n, 49_200n, 4_920n, 2_330n, 23n, 14_100n].map((a, i) => claim(`l${i}`, 'bayla', 'BAYLA', a));
    const [bayla, ...rest] = harvestTally(six);
    expect(rest).toEqual([]);
    expect(bayla).toMatchObject({ symbol: 'BAYLA', claims: 6, totalRaw: 141_173n, earning: [] });
  });

  it('never adds one coin to another: there is no price here to add them by', () => {
    const rows = harvestTally([
      claim('a', 'bayla', 'BAYLA', 5n), claim('b', 'bobo', 'BOBO', 7n), claim('c', 'bayla', 'BAYLA', 6n), claim('d', 'bobo', 'BOBO', 1n),
    ]);
    expect(rows.map((r) => [r.symbol, r.totalRaw, r.claims])).toEqual([['BAYLA', 11n, 2], ['BOBO', 8n, 2]]);
  });

  it('a coin with one claim and no daily figure has no row: its claim already says it', () => {
    expect(harvestTally([claim('a', 'bayla', 'BAYLA', 5n), claim('b', 'bobo', 'BOBO', 7n)])).toEqual([]);
  });

  it('carries a pool’s daily figure as it was stated, beside that coin’s total', () => {
    const e = earning('bayla', 'BAYLA');
    const [row] = harvestTally([claim('a', 'bayla', 'BAYLA', 5n)], [e]);
    expect(row).toMatchObject({ symbol: 'BAYLA', totalRaw: 5n, claims: 1 });
    expect(row!.earning).toEqual([e]);
  });

  it('a coin that is earning with nothing to claim has a row with no total, never a zero', () => {
    const [row] = harvestTally([], [earning('bayla', 'BAYLA')]);
    expect(row).toMatchObject({ symbol: 'BAYLA', totalRaw: null, claims: 0 });
    expect(row!.earning).toHaveLength(1);
  });

  it('amounts in a different number of decimals are never folded into one sum', () => {
    const rows = harvestTally([
      claim('a', 'bayla', 'BAYLA', 5n), claim('b', 'bayla', 'BAYLA', 6n),
      claim('c', 'bayla', 'BAYLA', 7n, { decimals: 9 }), claim('d', 'bayla', 'BAYLA', 8n, { decimals: 9 }),
    ]);
    expect(rows.map((r) => [r.decimals, r.totalRaw])).toEqual([[6, 11n], [9, 15n]]);
  });

  it('the same ticker on another chain is another coin', () => {
    const rows = harvestTally([
      claim('a', 'x', 'ETH', 1n, { chain: 'ethereum', decimals: 18 }), claim('b', 'x', 'ETH', 2n, { chain: 'ethereum', decimals: 18 }),
      claim('c', 'x', 'ETH', 4n, { chain: 'base', decimals: 18 }), claim('d', 'x', 'ETH', 8n, { chain: 'base', decimals: 18 }),
    ]);
    expect(rows.map((r) => [r.chain, r.totalRaw])).toEqual([['ethereum', 3n], ['base', 12n]]);
  });
});
