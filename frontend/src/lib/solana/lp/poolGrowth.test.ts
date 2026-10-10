// @vitest-environment node
//
// What a pool's shares have grown since it opened, from the pool state and its two vaults
// alone (no history read). Every expected figure is worked by hand here from the rule in
// words, on the venue's own BAYLA/SOL pool as mainnet held it (mainnetPool.fixture.ts).
import { describe, it, expect } from 'vitest';
import { FORECAST_WORDS } from './format';
import { OPEN_TIME, Rc, Rt, S, SOL_VAULT, THIRD_SWAP, VENUE_CUT, livePool } from './mainnetPool.fixture';
import { PACE_SENTENCE } from './pace';
import type { PoolView } from './poolFinder';
import { POOL_FEES_TOO_SMALL, poolEarned, shareGrowth, tradesExplain } from './poolGrowth';

/** The live pool with other balances, or another price record. */
function pool(o: { coin?: bigint; token?: bigint; supply?: bigint; history?: PoolView['history'] } = {}): PoolView {
  const v = livePool();
  return {
    ...v,
    quoteReserve: o.coin ?? v.quoteReserve,
    tokenReserve: o.token ?? v.tokenReserve,
    snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, lpSupply: o.supply ?? v.snapshot.pool.lpSupply } },
    history: o.history ?? v.history,
  };
}
/** The pool's own record with no swap written to it yet. */
function neverTraded(): PoolView['history'] {
  const h = livePool().history;
  if (h.kind !== 'ok') throw new Error('the fixture pool has no price record');
  return { kind: 'ok', obs: { ...h.obs, initialized: false, lastUpdate: 0n } };
}
// 2026-10-10 02:31:00 UTC, the chain time of the investigation's read: 544,376 s after the pool opened.
const NOW = 1_791_599_460n;
const TRADE = 'Last trade: 2026-10-09 02:50:49 UTC';

describe('shareGrowth: isqrt(coin reserve x token reserve) less the shares, over the shares', () => {
  it('the venue’s pool: 372,663,147,122 over 372,631,821,673 shares, 0.0084065% more behind each share', () => {
    const g = shareGrowth(livePool());
    expect(g).toEqual({ growth: 372_663_147_122n - S, supply: S });
    expect(g!.growth).toBe(31_325_449n);
    // 31,325,449 / 372,631,821,673 = 0.000084065...: as a percent, 0.0084065.
    expect((g!.growth * 10n ** 9n) / S).toBe(84_065n);
  });

  it('the reserve is the vault LESS the venue’s uncollected cut: the raw vault would say 0.0099%', () => {
    const view = livePool();
    // The finder read the vault whole and the reserve net of the 801,600 the venue is owed.
    expect(view.snapshot.vault0Amount).toBe(SOL_VAULT);
    expect(view.quoteReserve).toBe(SOL_VAULT - VENUE_CUT);
    expect(view.quoteReserve).toBe(Rc);
    // isqrt(25,648,407,921 x Rt) - S = 37,149,081: what counting the venue's cut as the shares' would give.
    expect(shareGrowth({ ...view, quoteReserve: SOL_VAULT })!.growth).toBe(37_149_081n);
    expect(shareGrowth(view)!.growth).toBe(31_325_449n);
  });

  it('is exactly zero at opening: initialize.rs mints isqrt of the two amounts as the supply (the 100 locked among them)', () => {
    // The pool's own opening: 1 SOL and 219,749.259037 BAYLA, isqrt = 14,823,942,088 = lp_supply.
    expect(shareGrowth(pool({ coin: 1_000_000_000n, token: 219_749_259_037n, supply: 14_823_942_088n }))).toEqual({ growth: 0n, supply: 14_823_942_088n });
  });

  it('a deposit alone lifts it a few units, with no swap: deposit.rs rounds what it takes up', () => {
    // The pool's first deposit: +990,099,010 lamports, +217,573,523,666 units for 14,677,170,375 shares.
    // isqrt(1,990,099,010 x 437,322,782,703) = 29,501,112,468 against 29,501,112,463 shares: 5 more.
    const g = shareGrowth(pool({ coin: 1_990_099_010n, token: 437_322_782_703n, supply: 29_501_112_463n }));
    expect(g).toEqual({ growth: 5n, supply: 29_501_112_463n });
  });

  it('no figure with no shares, an empty side, or a supply above the root (not a pool this program opened)', () => {
    expect(shareGrowth(pool({ supply: 0n }))).toBeNull();
    expect(shareGrowth(pool({ coin: 0n }))).toBeNull();
    expect(shareGrowth(pool({ token: 0n }))).toBeNull();
    expect(shareGrowth(pool({ supply: 372_663_147_123n }))).toBeNull();
  });
});

describe('tradesExplain: can the fees the pool still shows account for its growth?', () => {
  // The venue's uncollected cut is 801,600 lamports, 16% of the trade fees. The LPs' 84% of the same trades:
  // 801,600 x 840,000 / 160,000 = 4,208,400 lamports, the investigation's own figure for the three swaps.
  it('the venue’s pool: taking the LPs’ 4,208,400 lamports back out undoes 30,575,562 of the 31,325,449 growth', () => {
    const view = livePool();
    expect(view.config?.protocolFeeRate).toBe(160_000n);
    expect(view.snapshot.pool.protocolFeesToken0).toBe(VENUE_CUT);
    // isqrt((25,647,606,321 - 4,208,400) x Rt) = 372,632,571,560, which is 30,575,562 under the root.
    expect(tradesExplain(view)).toBe(true);
  });

  it('tokens sent straight to a vault are not trades: 1 SOL sent in leaves the fees explaining 29,996,328 of 7,226,923,849', () => {
    // The reserve grows by what was sent; the venue's counter does not move, because no trade paid a fee.
    expect(shareGrowth(pool({ coin: Rc + 1_000_000_000n }))!.growth).toBe(7_226_923_849n);
    expect(tradesExplain(pool({ coin: Rc + 1_000_000_000n }))).toBe(false);
    expect(tradesExplain(pool({ coin: Rc + 10_000_000_000n }))).toBe(false);
    // The line is at half: on this pool, up to 4,104,845 lamports sent in (about what the fees themselves were) still passes.
    expect(tradesExplain(pool({ coin: Rc + 4_104_845n }))).toBe(true);
    expect(tradesExplain(pool({ coin: Rc + 4_104_846n }))).toBe(false);
    // The token side is no different: BAYLA sent in is not a trade either.
    expect(tradesExplain(pool({ token: Rt + Rt / 25n }))).toBe(false);
  });

  it('with nothing to measure by, it is false: a collected cut, a tier with no venue cut, or fee settings that were not read', () => {
    const view = livePool();
    const noCut: PoolView = { ...view, snapshot: { ...view.snapshot, pool: { ...view.snapshot.pool, protocolFeesToken0: 0n, protocolFeesToken1: 0n } } };
    expect(tradesExplain(noCut)).toBe(false);
    expect(tradesExplain({ ...view, config: { ...view.config!, protocolFeeRate: 0n } })).toBe(false);
    expect(tradesExplain({ ...view, config: { ...view.config!, protocolFeeRate: 500_000n, fundFeeRate: 500_000n } })).toBe(false);
    expect(tradesExplain({ ...view, config: null })).toBe(false);
    // No growth at all, or no figure: nothing to explain.
    expect(tradesExplain(pool({ coin: 1_000_000_000n, token: 219_749_259_037n, supply: 14_823_942_088n }))).toBe(false);
    expect(tradesExplain(pool({ supply: 0n }))).toBe(false);
  });

  it('fees paid on the token side count the same: the cut is read from the side it was paid in', () => {
    const view = livePool();
    // The same share of the token reserve as 801,600 lamports is of the SOL reserve (about 169 million units).
    const cut = (VENUE_CUT * Rt) / Rc;
    const tokenSide: PoolView = { ...view, snapshot: { ...view.snapshot, pool: { ...view.snapshot.pool, protocolFeesToken0: 0n, protocolFeesToken1: cut } } };
    expect(view.quoteIsToken0).toBe(true);
    expect(tradesExplain(tokenSide)).toBe(true);
  });
});

describe('poolEarned: what the pool card says, with no history read', () => {
  it('tokens sent straight in: the growth is said for what it is, and there is no pace to call "Past trades"', () => {
    const e = poolEarned(pool({ coin: Rc + 1_000_000_000n }), NOW)!;
    expect(e.trade).toBe(TRADE);
    expect(e.growth).toBe('Since this pool opened on 2026-10-03 19:18 UTC, each share has grown 1.9% from trading fees and anything else sent into the pool.');
    expect(e.pace).toBeNull();
    // The reviewer's second case: one dust trade to flip the record, then half the pool's SOL sent in.
    const dust = poolEarned(pool({ coin: Rc + Rc / 2n }), NOW)!;
    expect(dust.growth).toMatch(/each share has grown 22% from/);
    expect(dust.pace).toBeNull();
    expect(JSON.stringify([e, dust])).not.toMatch(FORECAST_WORDS);
  });

  it('the venue’s pool, 6.3 days after it opened: the last trade, the growth since it opened, and the pace', () => {
    // 544,376 s is 6.3006 days. 0.0084065% x 31,536,000 / 544,376 = 0.48699%, cut to 0.48%.
    expect(poolEarned(livePool(), NOW)).toEqual({
      trade: TRADE,
      growth: 'Since this pool opened on 2026-10-03 19:18 UTC, each share has grown 0.0084% from trading fees and anything else sent into the pool.',
      pace: '0.0084% in 6.3 days. At that pace, about 0.48% a year. Past trades, not a forecast.',
    });
    expect(BigInt(THIRD_SWAP)).toBeGreaterThan(OPEN_TIME);
  });

  it('a pool younger than a day: the percent and the time, and no yearly figure', () => {
    const young = poolEarned(livePool(), OPEN_TIME + 23n * 3_600n)!;
    expect(young.pace).toBe('0.0084% in 23 hours. Past trades, not a forecast.');
    expect(young.growth).toMatch(/each share has grown 0\.0084% from/);
  });

  it('the pace is measured to the chain’s clock: with none read, or one behind the opening, there is no pace and the growth still stands', () => {
    for (const now of [null, OPEN_TIME - 60n, OPEN_TIME]) {
      const e = poolEarned(livePool(), now)!;
      expect(e.pace).toBeNull();
      expect(e.growth).toMatch(/^Since this pool opened on 2026-10-03 19:18 UTC, each share has grown 0\.0084% /);
    }
  });

  it('no trade has reached the pool: it says so, and never calls the deposits’ rounding a fee', () => {
    // The ratio is already 5 units over zero after one deposit: "no fees yet" is the record's answer, not a test for zero.
    const v = pool({ coin: 1_990_099_010n, token: 437_322_782_703n, supply: 29_501_112_463n, history: neverTraded() });
    expect(shareGrowth(v)!.growth).toBe(5n);
    expect(poolEarned(v, NOW)).toEqual({ trade: 'No trade has reached this pool yet, so there are no fees yet.', growth: null, pace: null });
  });

  it('a trade record that could not be read: said, with no figure of any kind', () => {
    const e = poolEarned(pool({ history: { kind: 'unread', detail: 'its price record account is missing' } }), NOW)!;
    expect(e).toEqual({ trade: 'Its trade record could not be read (its price record account is missing).', growth: null, pace: null });
    expect(JSON.stringify(e)).not.toMatch(/\d/);
  });

  it('a record that was never asked for says nothing at all', () => {
    expect(poolEarned(pool({ history: { kind: 'not-read' } }), NOW)).toBeNull();
  });

  it('a trade on the record and nothing measurable behind it: said in words, never as 0%', () => {
    // A swap too small to book a fee still writes the record; the root equals the supply.
    const e = poolEarned(pool({ coin: 1_000_000_000n, token: 219_749_259_037n, supply: 14_823_942_088n }), NOW)!;
    expect(e).toEqual({ trade: TRADE, growth: POOL_FEES_TOO_SMALL, pace: null });
    expect(POOL_FEES_TOO_SMALL).toBe('The fees so far are too small to show.');
  });

  it('nothing to value the shares against (no shares, an empty side): the last trade only', () => {
    for (const v of [pool({ supply: 0n }), pool({ coin: 0n })]) expect(poolEarned(v, NOW)).toEqual({ trade: TRADE, growth: null, pace: null });
  });

  it('an open time no calendar holds prints no date and no figure', () => {
    const v = livePool();
    const far: PoolView = { ...v, snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, openTime: 18_446_744_073_709_551_615n } } };
    expect(poolEarned(far, NOW)).toEqual({ trade: TRADE, growth: null, pace: null });
  });

  it('the only forecast word is inside the pace sentence, whole; nothing else promises anything, and there is no em dash', () => {
    const views = [livePool(), pool({ history: neverTraded() }), pool({ history: { kind: 'unread', detail: 'x' } }), pool({ coin: 1_000_000_000n, token: 219_749_259_037n, supply: 14_823_942_088n })];
    const lines = views.flatMap((v) => [NOW, OPEN_TIME + 3_600n, null].flatMap((now) => Object.values(poolEarned(v, now) ?? {}))).filter((s): s is string => typeof s === 'string');
    expect(lines.length).toBeGreaterThan(12);
    expect(lines.some((l) => FORECAST_WORDS.test(l))).toBe(true);
    for (const line of lines) {
      expect(line.replace(PACE_SENTENCE, '')).not.toMatch(FORECAST_WORDS);
      expect(line).not.toContain('—');
    }
    // The growth sentence itself never carries the yearly figure: that is the pace sentence's alone.
    expect(poolEarned(livePool(), NOW)!.growth).not.toMatch(FORECAST_WORDS);
  });
});
