// The Island Cup's arithmetic and its coverage rules.
//
// Everything here is pure. The point of the split is that the two claims most
// likely to be wrong — "this is the window we can speak for" and "this figure is
// what the feed said" — are decided in a file with no network in it, so they can
// be pinned exactly rather than observed occasionally.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CUP_RANK_MEANING,
  GT_TRADES_PAGE_CAP,
  buildCupBoard,
  cupBoardStatus,
  cupPools,
  cupShareText,
  findRank,
  formatUsdMicros,
  tradeRowsFromTrades,
  tradesToLegs,
  utcMinute,
  type CupPool,
  type PoolOutcome,
} from './islandCup';
import { BUNGALOWS } from '../bungalows';
import { TOWELI_MARKET } from '../chart/market';
import type { PoolTrade } from '../geckoTerminal/poolTrades';

const T0 = 1_780_000_000;
const iso = (at: number) => new Date(at * 1000).toISOString();

const ethPool: CupPool = {
  id: 'pepe',
  name: 'Pepe',
  symbol: 'PEPE',
  network: 'eth',
  pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  label: 'PEPE / WETH',
  chain: 'ethereum',
};

const solPool: CupPool = {
  id: 'bobo',
  name: 'BOBO',
  symbol: 'BOBO',
  network: 'solana',
  pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
  label: 'BOBO / SOL',
  chain: 'solana',
};

function trade(over: Partial<PoolTrade> = {}): PoolTrade {
  return {
    at: iso(T0),
    kind: 'buy',
    txHash: '0xtx1',
    wallet: '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd',
    tokenAmount: 1,
    usd: 1,
    fromTokenAddress: null,
    toTokenAddress: null,
    fromTokenAmount: null,
    toTokenAmount: null,
    blockNumber: null,
    ...over,
  };
}

function ok(pool: CupPool, trades: PoolTrade[]): { pool: CupPool; outcome: PoolOutcome } {
  const { rows, returned, dropped } = tradeRowsFromTrades(pool, trades);
  return { pool, outcome: { ok: true, rows, returned, dropped } };
}

function failed(pool: CupPool, reason = 'rate-limited'): { pool: CupPool; outcome: PoolOutcome } {
  return { pool, outcome: { ok: false, reason, detail: 'The feed is rate-limiting right now.' } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cupPools', () => {
  it('lists every live resident that names a market, exactly once', () => {
    const pools = cupPools();
    const registry = BUNGALOWS.filter((b) => b.live && b.market);
    // Derived from the registry rather than hardcoded: a resident added tomorrow
    // must appear on the board without anybody remembering to bump a literal.
    expect(pools).toHaveLength(registry.length + 1);
    for (const b of registry) {
      expect(pools.some((p) => p.id === b.id), `${b.id} missing from the cup`).toBe(true);
    }
    expect(new Set(pools.map((p) => `${p.network}:${p.pool.toLowerCase()}`)).size).toBe(pools.length);
  });

  it("includes the venue's own pool, which no bungalow entry carries", () => {
    // TOWELI's bungalow has no `market` field — its pool lives in chart/market.ts
    // — so a naive registry filter would silently leave the house's own pool off
    // the house's own board.
    const toweli = cupPools().find((p) => p.id === 'toweli');
    expect(toweli).toBeTruthy();
    expect(toweli!.pool).toBe(TOWELI_MARKET.pool);
    expect(toweli!.network).toBe(TOWELI_MARKET.network);
  });

  it('includes a resident whatever its status word says, and excludes one with no market', () => {
    // Bayla is 'NEWEST', not 'SETTLED'; filtering on status would drop her.
    expect(cupPools().some((p) => p.id === 'bayla')).toBe(true);
    // nb1 is the unmarked plot: not live, no market.
    expect(cupPools().some((p) => p.id === 'nb1')).toBe(false);
  });
});

describe('tradeRowsFromTrades', () => {
  it('keeps a sub-cent fill at micro-dollar precision', () => {
    // Rounded at the half micro-dollar, not truncated: a truncating build
    // returns 23495n here and quietly shaves every fill on the board.
    const { rows, dropped } = tradeRowsFromTrades(ethPool, [trade({ usd: 0.0234958729 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usdMicros).toBe(23_496n);
    expect(dropped).toBe(0);
  });

  it('keeps a large fill exact rather than routing it through a float multiply', () => {
    const { rows } = tradeRowsFromTrades(ethPool, [trade({ usd: 1_234_567.891234 })]);
    expect(rows[0]!.usdMicros).toBe(1_234_567_891_234n);
  });

  it('sums exactly across many small fills', () => {
    // A float accumulator drifts here; integer micro-dollars cannot.
    const trades = Array.from({ length: 1000 }, () => trade({ usd: 0.01 }));
    const { rows } = tradeRowsFromTrades(ethPool, trades);
    const total = rows.reduce((acc, r) => acc + r.usdMicros, 0n);
    expect(total).toBe(10_000_000n);
    expect(formatUsdMicros(total)).toBe('$10.00');
  });

  it('DROPS a fill with no sender, and counts the drop', () => {
    // Never `?? ''`. An empty-string sender becomes a row on the leaderboard.
    const { rows, dropped, returned } = tradeRowsFromTrades(ethPool, [trade({ wallet: null })]);
    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
    expect(returned).toBe(1);
  });

  it('DROPS a fill with no USD size, and counts the drop', () => {
    // Never `?? 0`. A zero-dollar trade is a claim the feed did not make.
    const { rows, dropped } = tradeRowsFromTrades(ethPool, [trade({ usd: null })]);
    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('DROPS a fill whose timestamp cannot be parsed', () => {
    const { rows, dropped } = tradeRowsFromTrades(ethPool, [trade({ at: 'not-a-date' })]);
    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('DROPS a figure too large to be money', () => {
    const { rows, dropped } = tradeRowsFromTrades(ethPool, [trade({ usd: 1e21 })]);
    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('keeps both fills of one transaction, with distinct ordinals and leg ids', () => {
    // A dedupe keyed on tx_hash alone loses the second half of every multi-hop
    // route, which on a volume board is a silent under-count of the busiest
    // traders.
    const { rows } = tradeRowsFromTrades(ethPool, [
      trade({ txHash: '0xsame' }),
      trade({ txHash: '0xsame', kind: 'sell' }),
    ]);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
    const ids = tradesToLegs(rows).map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('lowercases an EVM sender and leaves a base58 one byte-identical', () => {
    const evm = tradeRowsFromTrades(ethPool, [trade()]).rows[0]!;
    expect(evm.sender).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');

    const key = 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5';
    const sol = tradeRowsFromTrades(solPool, [trade({ wallet: key })]).rows[0]!;
    expect(sol.sender).toBe(key);
  });
});

describe('tradesToLegs', () => {
  it('opposes buys and sells on the same pool and nothing else', () => {
    const rows = tradeRowsFromTrades(ethPool, [
      trade({ kind: 'buy' }),
      trade({ kind: 'sell', txHash: '0xtx2' }),
    ]).rows;
    const legs = tradesToLegs(rows);
    expect(legs[0]!.pairKey).toBe(legs[1]!.pairKey);
    expect(legs[0]!.direction).toBe('a>b');
    expect(legs[1]!.direction).toBe('b>a');
    expect(legs.every((l) => l.counted)).toBe(true);
  });
});

describe('buildCupBoard — coverage', () => {
  const capPage = (pool: CupPool, oldest: number) =>
    Array.from({ length: GT_TRADES_PAGE_CAP }, (_, i) =>
      trade({ at: iso(oldest + i), txHash: `0x${pool.id}${i}` }),
    );

  it('marks a pool capped exactly at the page cap, and reads its coverage floor', () => {
    // Mutating `>=` to `>` here reports a full page as fully covered, which is
    // the exact claim the cap exists to refuse.
    const full = buildCupBoard([ok(ethPool, capPage(ethPool, T0))]);
    expect(full.coverage[0]!.state).toBe('capped');
    expect(full.coverage[0]).toMatchObject({ coveredFrom: T0 });

    const oneShort = buildCupBoard([ok(ethPool, capPage(ethPool, T0).slice(0, -1))]);
    expect(oneShort.coverage[0]!.state).toBe('read');
  });

  it('narrows the scored window to the latest capped pool, and counts what falls outside', () => {
    const capped = ok(ethPool, capPage(ethPool, T0 + 10_000));
    const quiet = ok(solPool, [
      trade({ at: iso(T0), txHash: '0xold', wallet: 'Aaa' }),
      trade({ at: iso(T0 + 20_000), txHash: '0xnew', wallet: 'Bbb' }),
    ]);

    const board = buildCupBoard([capped, quiet]);
    expect(board.windowFrom).toBe(T0 + 10_000);
    expect(board.legsOutsideWindow).toBe(1);
    // The fill from before the window contributes to no row at all.
    expect(board.rows.some((r) => r.wallet === 'Aaa')).toBe(false);
    expect(board.rows.some((r) => r.wallet === 'Bbb')).toBe(true);
  });

  it("does NOT treat an uncapped pool's oldest fill as a coverage bound", () => {
    // An uncapped page covers everything the feed served, so its first fill is a
    // fact about trading, not about coverage. Using it would shrink the window to
    // the quietest pool's first trade and throw away real fills.
    const quiet = ok(solPool, [trade({ at: iso(T0 + 50_000), wallet: 'Bbb', txHash: '0xq' })]);
    const busy = ok(ethPool, [
      trade({ at: iso(T0), wallet: 'Aaa', txHash: '0xb1' }),
      trade({ at: iso(T0 + 60_000), wallet: 'Aaa', txHash: '0xb2' }),
    ]);
    const board = buildCupBoard([quiet, busy]);
    expect(board.windowFrom).toBeNull();
    expect(board.legsOutsideWindow).toBe(0);
    expect(board.legsRead).toBe(3);
  });

  it('keeps a failed pool in coverage rather than dropping it', () => {
    // A missing chip and a quiet pool look identical on screen and mean opposite
    // things.
    const board = buildCupBoard([ok(ethPool, [trade()]), failed(solPool)]);
    expect(board.coverage).toHaveLength(2);
    expect(board.coverage[1]).toMatchObject({ state: 'failed', reason: 'rate-limited' });
    expect(board.poolsAnswered).toBe(1);
    expect(board.poolsTotal).toBe(2);
  });

  it('refuses to call a full page of unreadable fills a clean read', () => {
    const junk = Array.from({ length: GT_TRADES_PAGE_CAP }, () => trade({ usd: null }));
    const board = buildCupBoard([ok(ethPool, junk)]);
    expect(board.coverage[0]!.state).toBe('failed');
    expect(cupBoardStatus(board)).toBe('unavailable');
  });
});

describe('cupBoardStatus', () => {
  it('is complete only when every pool answered in full', () => {
    expect(cupBoardStatus(buildCupBoard([ok(ethPool, [trade()]), ok(solPool, [])]))).toBe('complete');
  });

  it('is partial when any pool failed, and the failure contributes no rows', () => {
    const board = buildCupBoard([ok(ethPool, [trade()]), failed(solPool)]);
    expect(cupBoardStatus(board)).toBe('partial');
    expect(board.rows).toHaveLength(1);
  });

  it('is partial when any pool capped', () => {
    const page = Array.from({ length: GT_TRADES_PAGE_CAP }, (_, i) =>
      trade({ at: iso(T0 + i), txHash: `0xc${i}` }),
    );
    expect(cupBoardStatus(buildCupBoard([ok(ethPool, page)]))).toBe('partial');
  });

  it('is unavailable when nothing answered, with no rows at all', () => {
    const board = buildCupBoard([failed(ethPool), failed(solPool)]);
    expect(cupBoardStatus(board)).toBe('unavailable');
    expect(board.rows).toEqual([]);
    expect(board.newestFillAt).toBeNull();
  });

  it('is unavailable when no pool was even offered', () => {
    expect(cupBoardStatus(buildCupBoard([]))).toBe('unavailable');
  });
});

describe('the wash rule reaches this board too', () => {
  it('a sender who only round-trips one pool ranks below one $1 buy', () => {
    const washer = 'Wash';
    const honest = 'Hon';
    const trades: PoolTrade[] = [];
    for (let i = 0; i < 10; i += 1) {
      trades.push(
        trade({ wallet: washer, kind: 'buy', usd: 500, at: iso(T0 + i * 120), txHash: `0xw${i}a` }),
      );
      trades.push(
        trade({ wallet: washer, kind: 'sell', usd: 500, at: iso(T0 + i * 120 + 30), txHash: `0xw${i}b` }),
      );
    }
    trades.push(trade({ wallet: honest, usd: 1, at: iso(T0 + 5), txHash: '0xh' }));

    const board = buildCupBoard([ok(solPool, trades)]);
    expect(board.rows[0]!.wallet).toBe(honest);
    expect(board.rows[0]!.countedVolume).toBe(1_000_000n);
    const w = board.rows.find((r) => r.wallet === washer)!;
    expect(w.countedVolume).toBe(0n);
    expect(w.washedLegs).toBe(20);
    expect(board.washedLegs).toBe(20);
  });

  it('counts how many pools a sender actually touched', () => {
    const board = buildCupBoard([
      ok(ethPool, [trade({ wallet: '0xaaa', usd: 5, txHash: '0x1' })]),
      ok(solPool, [trade({ wallet: '0xaaa', usd: 5, txHash: '0x2' })]),
    ]);
    expect(board.rows[0]!.poolsTouched).toBe(2);
  });
});

describe('findRank', () => {
  const board = buildCupBoard([
    ok(ethPool, [trade({ wallet: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', usd: 9, txHash: '0x1' })]),
    ok(solPool, [trade({ wallet: 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5', usd: 3, txHash: '0x2' })]),
  ]);

  it('matches an EVM address case-insensitively', () => {
    expect(findRank(board, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')?.rank).toBe(1);
    expect(findRank(board, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')?.rank).toBe(1);
  });

  it('matches a base58 key exactly and never by lowercasing it', () => {
    expect(findRank(board, 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5')?.rank).toBe(2);
    expect(findRank(board, 'djfp3qjrofzcvzj3yowpmrnu6womo6njvb3dywtewua5')).toBeNull();
  });

  it('returns null for an absent wallet — never a rank of 0', () => {
    // `findIndex(...) + 1` returns 0 for a miss, which renders as "#0" and reads
    // as a real, terrible position rather than as an absence.
    const miss = findRank(board, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(miss).toBeNull();
    expect(findRank(board, '   ')).toBeNull();
  });

  it('reports the size of the field it ranked against', () => {
    expect(findRank(board, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')?.of).toBe(2);
  });
});

describe('every time on this board comes from a block timestamp', () => {
  it('does not move when the clock does', () => {
    // A Date.now()-derived "as of" would drift on every render and would keep
    // ageing after the data stopped.
    const board = buildCupBoard([ok(ethPool, [trade({ at: iso(T0) })])]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    const later = buildCupBoard([ok(ethPool, [trade({ at: iso(T0) })])]);
    expect(later.newestFillAt).toBe(board.newestFillAt);
    expect(later.oldestFillAt).toBe(board.oldestFillAt);
    expect(later.newestFillAt).toBe(T0);
    expect(utcMinute(T0)).toBe('2026-05-28 20:26 UTC');
  });
});

describe('the shareable sentence carries its caveats', () => {
  it('says provisional and names the pools answered when the board is partial', () => {
    const text = cupShareText(3, 40, 11, 12, 'partial', utcMinute(T0));
    expect(text).toContain('#3 of 40 wallets');
    expect(text).toContain('11 of 12 pools answered');
    expect(text).toContain('provisional');
  });

  it('omits provisional only when every pool answered in full', () => {
    expect(cupShareText(1, 2, 12, 12, 'complete', utcMinute(T0))).not.toContain('provisional');
  });
});

describe('formatUsdMicros', () => {
  it('groups and keeps cents without touching Number', () => {
    expect(formatUsdMicros(0n)).toBe('$0.00');
    expect(formatUsdMicros(1_234_567_891_234n)).toBe('$1,234,567.89');
    // Far beyond a double's exact-integer range: a Number() round trip loses the
    // last digits here.
    expect(formatUsdMicros(98_765_432_109_876_543_210n)).toBe('$98,765,432,109,876.54');
  });
});

describe('the page states what a rank is', () => {
  it('names the three things a rank is not', () => {
    expect(CUP_RANK_MEANING).toMatch(/not a ranking of all trading/i);
    expect(CUP_RANK_MEANING).toMatch(/not profit/i);
    expect(CUP_RANK_MEANING).toMatch(/pays nothing/i);
  });
});
