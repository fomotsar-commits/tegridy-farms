// The 24h average traded price: its sum, its window, its floor, which side GeckoTerminal's
// candles price, and that a read that failed is never a number or a "no pool".
// Responses are built in the shape GeckoTerminal answered on 2026-10-14 (version 20230302):
// a pool list's `relationships.base_token.data.id` is "solana_<mint>", its 24h volume a string,
// and an ohlcv answer names its base and quote in `meta`, with volume in the QUOTE coin.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAllowedPath } from '../../../../api/_lib/gecko-read.js';
import { SOL_MINT, USDC_MINT } from '../../solana';
import {
  MIN_TRADED_QUARTER_HOURS,
  fetchPairAverage,
  findPairPool,
  forgetPairAverages,
  orientAverage,
  readCandles,
  sayAs,
  tradeVsAverage,
  volumeWeighted,
} from './pairAverage';

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const TBBB = 'mGZypHvkPkpRjUvLuwUjtz3QH5V3kj46xT6qzoa1Fm8';
const BAYLA_SOL_POOL = '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n';
const NOW = 1_791_966_400;

function poolEntry(address: string, base: string, quote: string, opts: { buys?: number; sells?: number; volume?: string } = {}) {
  return {
    id: `solana_${address}`,
    type: 'pool',
    attributes: {
      name: 'X / Y',
      address,
      volume_usd: { m5: '0.0', h1: '0.0', h6: '407.49', h24: opts.volume ?? '2153.31629981' },
      transactions: { h24: { buys: opts.buys ?? 126, sells: opts.sells ?? 119, buyers: 67, sellers: 98 } },
    },
    relationships: {
      base_token: { data: { id: `solana_${base}`, type: 'token' } },
      quote_token: { data: { id: `solana_${quote}`, type: 'token' } },
      dex: { data: { id: 'pumpswap', type: 'dex' } },
    },
  };
}

function ohlcv(base: string, quote: string, rows: number[][]) {
  return {
    data: { id: 'x', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } },
    meta: {
      base: { name: 'B', symbol: 'B', coingecko_coin_id: null, address: base },
      quote: { name: 'Q', symbol: 'Q', coingecko_coin_id: null, address: quote },
    },
  };
}

/** n quarter-hour candles, newest first as GeckoTerminal sends them, each [ts, o, h, l, c, v]. */
function quarterHours(n: number, price: (i: number) => number, vol: (i: number) => number, start = NOW - 60): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const p = price(i);
    return [start - i * 900, p, p * 1.01, p * 0.99, p, vol(i)];
  });
}

describe('volumeWeighted', () => {
  it('is sum(V) / sum(V / P) with P = (high + low + close) / 3, volume in the quote coin', () => {
    const rows = [
      ...quarterHours(6, () => 0.000005, () => 2),
      ...quarterHours(4, () => 0.000006, () => 1, NOW - 60 - 6 * 900),
    ];
    // Typical price here is (1.01p + 0.99p + p) / 3 = p.
    const want = (6 * 2 + 4 * 1) / (12 / 0.000005 + 4 / 0.000006);
    expect(volumeWeighted(rows, NOW)).toBeCloseTo(want, 15);
  });

  it('counts only candles opened in the last 24 hours', () => {
    const inside = quarterHours(10, () => 2, () => 5);
    const old = [[NOW - 86_400 - 1, 100, 100, 100, 100, 1e9]];
    expect(volumeWeighted([...inside, ...old], NOW)).toBeCloseTo(2, 12);
  });

  it(`is "thin" under ${MIN_TRADED_QUARTER_HOURS} traded quarter-hours, and an empty candle is not one`, () => {
    const rows = [...quarterHours(MIN_TRADED_QUARTER_HOURS - 1, () => 2, () => 5), ...quarterHours(30, () => 2, () => 0, NOW - 60 - 20 * 900)];
    expect(volumeWeighted(rows, NOW)).toBe('thin');
    expect(volumeWeighted(quarterHours(MIN_TRADED_QUARTER_HOURS, () => 2, () => 5), NOW)).toBeCloseTo(2, 12);
  });

  it('a malformed candle inside the window is "unread", never skipped into a number', () => {
    const rows = quarterHours(20, () => 2, () => 5);
    expect(volumeWeighted([...rows, [NOW - 100, 2, 'x', 2, 2, 5]], NOW)).toBe('unread');
    expect(volumeWeighted([...rows, [NOW - 100, 2, 2, 2, 0, 5]], NOW)).toBe('unread');
    expect(volumeWeighted([...rows, 'row'], NOW)).toBe('unread');
    // Outside the window, its prices are not read at all.
    expect(volumeWeighted([...rows, [NOW - 90_000, 2, 'x', 2, 2, 5]], NOW)).toBeCloseTo(2, 12);
  });
});

describe('which side the candles price (GeckoTerminal prices the FIRST-named token)', () => {
  it('BAYLA first in a BAYLA/SOL pool: said as BAYLA in SOL, as read', () => {
    expect(orientAverage({ baseMint: BAYLA, quoteMint: SOL_MINT }, 0.0000052, SOL_MINT, BAYLA)).toEqual({
      kind: 'ok', baseMint: BAYLA, quoteMint: SOL_MINT, price: 0.0000052,
    });
  });

  it('SOL first in a SOL/BAYLA pool: turned round, so the line never says one BAYLA is worth 190,000 SOL', () => {
    const got = orientAverage({ baseMint: SOL_MINT, quoteMint: BAYLA }, 190_000, SOL_MINT, BAYLA);
    expect(got.kind).toBe('ok');
    if (got.kind !== 'ok') return;
    expect(got.baseMint).toBe(BAYLA);
    expect(got.quoteMint).toBe(SOL_MINT);
    expect(got.price).toBeCloseTo(1 / 190_000, 15);
  });

  it('turning round is exact: the same trades listed either way give the same average', () => {
    const p = (i: number) => 0.000005 + i * 1e-8;
    const v = (i: number) => 1 + (i % 3);
    // Flat candles, so (h + l + c) / 3 is the price both ways round.
    const flat = (rows: number[][]) => rows.map(([ts, , , , c, vol]) => [ts, c, c, c, c, vol]);
    const asBayla = flat(quarterHours(40, p, v));
    const asSol = asBayla.map(([ts, , , , c, vol]) => [ts, 1 / c, 1 / c, 1 / c, 1 / c, vol / c]);
    const a = orientAverage({ baseMint: BAYLA, quoteMint: SOL_MINT }, volumeWeighted(asBayla, NOW) as number, BAYLA, SOL_MINT);
    const b = orientAverage({ baseMint: SOL_MINT, quoteMint: BAYLA }, volumeWeighted(asSol, NOW) as number, BAYLA, SOL_MINT);
    expect(a.kind === 'ok' && b.kind === 'ok' && Math.abs(a.price / b.price - 1)).toBeLessThan(1e-12);
  });

  it('candles for another pair are "unread": USDC\'s top pool prices SOL, not USDC', () => {
    expect(orientAverage({ baseMint: SOL_MINT, quoteMint: USDC_MINT }, 107.6, USDC_MINT, BAYLA)).toEqual({ kind: 'unread' });
  });

  it('a dollar coin is the quote over SOL, and SOL over any other coin; a tie keeps the order given', () => {
    expect(sayAs(USDC_MINT, SOL_MINT)).toEqual([SOL_MINT, USDC_MINT]);
    expect(sayAs(SOL_MINT, BAYLA)).toEqual([BAYLA, SOL_MINT]);
    expect(sayAs(TBBB, BAYLA)).toEqual([TBBB, BAYLA]);
  });
});

describe('this trade against the average', () => {
  const avg = { baseMint: BAYLA, quoteMint: SOL_MINT, price: 0.000005 };
  it('buying BAYLA with SOL at 0.0000055 SOL each is 10% above', () => {
    expect(tradeVsAverage(avg, { payMint: SOL_MINT, buyMint: BAYLA, payAmount: 0.0055, buyAmount: 1000 })).toBeCloseTo(10, 9);
  });
  it('selling BAYLA for 0.0000045 SOL each is 10% below', () => {
    expect(tradeVsAverage(avg, { payMint: BAYLA, buyMint: SOL_MINT, payAmount: 1000, buyAmount: 0.0045 })).toBeCloseTo(-10, 9);
  });
  it('no figure without both amounts, or for another pair', () => {
    expect(tradeVsAverage(avg, { payMint: SOL_MINT, buyMint: BAYLA, payAmount: null, buyAmount: 1 })).toBeNull();
    expect(tradeVsAverage(avg, { payMint: SOL_MINT, buyMint: BAYLA, payAmount: 1, buyAmount: 0 })).toBeNull();
    expect(tradeVsAverage(avg, { payMint: USDC_MINT, buyMint: BAYLA, payAmount: 1, buyAmount: 1 })).toBeNull();
  });
});

describe('findPairPool and readCandles', () => {
  const list = { data: [poolEntry(BAYLA_SOL_POOL.replace('8', '9'), TBBB, BAYLA), poolEntry(BAYLA_SOL_POOL, BAYLA, SOL_MINT)] };
  it('takes the first pool holding exactly the pair, either way round, with its 24h counts', () => {
    expect(findPairPool(list, SOL_MINT, BAYLA)).toEqual({
      address: BAYLA_SOL_POOL, baseMint: BAYLA, quoteMint: SOL_MINT, trades24h: 245, volumeUsd24h: 2153.31629981,
    });
    expect(findPairPool(list, USDC_MINT, BAYLA)).toBeNull();
  });
  it('a list that is not a list is "unread"; counts it does not give are null', () => {
    expect(findPairPool({ errors: [{ status: '429' }] }, SOL_MINT, BAYLA)).toBe('unread');
    const bare = poolEntry(BAYLA_SOL_POOL, BAYLA, SOL_MINT);
    (bare.attributes as Record<string, unknown>).transactions = {};
    expect(findPairPool({ data: [bare] }, SOL_MINT, BAYLA)).toMatchObject({ trades24h: null });
  });
  it('an ohlcv answer without its meta cannot say which side it prices: unreadable', () => {
    expect(readCandles({ data: { attributes: { ohlcv_list: [] } } })).toBeNull();
    expect(readCandles(ohlcv(BAYLA, SOL_MINT, []))).toEqual({ baseMint: BAYLA, quoteMint: SOL_MINT, rows: [] });
  });
});

describe('fetchPairAverage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetPairAverages();
  });

  /** A fetch that answers by path, and records each URL asked for. */
  function stubFetch(answer: (path: string) => { status: number; body: unknown }) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const path = decodeURIComponent(new URL(url, 'https://memetics.finance').searchParams.get('path') ?? '');
      const { status, body } = answer(path);
      return new Response(JSON.stringify(body), { status });
    }));
    return urls;
  }
  const baylaList = { data: [poolEntry(BAYLA_SOL_POOL, BAYLA, SOL_MINT)] };
  const now = () => NOW * 1000;

  it('BAYLA/SOL: reads BAYLA\'s pools, then that pool\'s candles in SOL, through our own origin', async () => {
    const urls = stubFetch((p) =>
      p.endsWith('/pools') ? { status: 200, body: baylaList } : { status: 200, body: ohlcv(BAYLA, SOL_MINT, quarterHours(60, () => 0.000005, () => 1)) },
    );
    const got = await fetchPairAverage(SOL_MINT, BAYLA, undefined, now);
    expect(got).toMatchObject({ kind: 'ok', baseMint: BAYLA, quoteMint: SOL_MINT });
    expect(got.kind === 'ok' && got.price).toBeCloseTo(0.000005, 15);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(`/networks/solana/tokens/${BAYLA}/pools`);
    expect(urls[1]).toContain(`/networks/solana/pools/${BAYLA_SOL_POOL}/ohlcv/minute`);
    expect(urls[1]).toContain('currency=token');
    for (const u of urls) {
      expect(u.startsWith('/api/aggregator?resource=gecko-read')).toBe(true);
      const params = new URL(u, 'https://memetics.finance').searchParams;
      expect(isAllowedPath(params.get('path'))).toBe(true);
    }
    // Asked again within the minute, the other way round: nothing is read again.
    await fetchPairAverage(BAYLA, SOL_MINT, undefined, now);
    expect(urls).toHaveLength(2);
  });

  it('under the floor it is "thin", and no candles are asked for', async () => {
    const urls = stubFetch(() => ({ status: 200, body: { data: [poolEntry(BAYLA_SOL_POOL, BAYLA, SOL_MINT, { buys: 10, sells: 9 })] } }));
    expect(await fetchPairAverage(SOL_MINT, BAYLA, undefined, now)).toEqual({ kind: 'thin' });
    forgetPairAverages();
    stubFetch(() => ({ status: 200, body: { data: [poolEntry(BAYLA_SOL_POOL, BAYLA, SOL_MINT, { volume: '999.99' })] } }));
    expect(await fetchPairAverage(SOL_MINT, BAYLA, undefined, now)).toEqual({ kind: 'thin' });
    expect(urls).toHaveLength(1);
  });

  it('one pool list read that failed is "could not be read", never "no pool"', async () => {
    stubFetch((p) => (p.includes(BAYLA) ? { status: 429, body: {} } : { status: 200, body: { data: [] } }));
    expect(await fetchPairAverage(SOL_MINT, BAYLA, undefined, now)).toEqual({ kind: 'unread' });
  });

  it('both lists read and neither has the pair: "none"', async () => {
    stubFetch(() => ({ status: 200, body: { data: [] } }));
    expect(await fetchPairAverage(SOL_MINT, BAYLA, undefined, now)).toEqual({ kind: 'none' });
  });

  it('candles that failed, or that price another pair, are "unread", and that is not kept', async () => {
    let candles: { status: number; body: unknown } = { status: 502, body: {} };
    const urls = stubFetch((p) => (p.endsWith('/pools') ? { status: 200, body: baylaList } : candles));
    expect(await fetchPairAverage(SOL_MINT, BAYLA, undefined, now)).toEqual({ kind: 'unread' });
    candles = { status: 200, body: ohlcv(SOL_MINT, USDC_MINT, quarterHours(60, () => 107, () => 1)) };
    expect(await fetchPairAverage(SOL_MINT, BAYLA, undefined, now)).toEqual({ kind: 'unread' });
    expect(urls).toHaveLength(4);
  });
});

describe('real answers (GeckoTerminal, read 2026-10-14, kept in geckoTerminal/fixtures)', () => {
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(resolve(process.cwd(), 'src/lib/geckoTerminal/fixtures', name), 'utf8'));
  const baylaCandles = fixture('solana_bayla_sol_ohlcv_15m_token.json');
  const solCandles = fixture('solana_sol_usdc_ohlcv_15m_token.json');
  const baylaPools = fixture('solana_bayla_pools.json');
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetPairAverages();
  });

  it('BAYLA/SOL: 100 candles over 30 hours (empty quarter-hours are left out), 80 of them in the last 24', () => {
    const c = readCandles(baylaCandles);
    expect(c).not.toBeNull();
    if (!c) return;
    // The answer prices BAYLA, the pool's first-named coin, in SOL; volume is in SOL too.
    expect([c.baseMint, c.quoteMint]).toEqual([BAYLA, SOL_MINT]);
    const now = 1_791_960_360; // a minute after the newest candle opened
    const avg = volumeWeighted(c.rows, now);
    // Worked out by hand from the same rows: sum(V) / sum(V / ((h + l + c) / 3)).
    // Close alone would give 0.000005135; price times volume over volume, 0.0000051543.
    expect(avg).toBeCloseTo(0.000005153108607396, 17);
    const got = orientAverage(c, avg as number, SOL_MINT, BAYLA);
    expect(got).toMatchObject({ kind: 'ok', baseMint: BAYLA, quoteMint: SOL_MINT });
  });

  it('SOL/USDC: SOL in USDC, about 107.19, inside the day\'s low and high', () => {
    const c = readCandles(solCandles);
    if (!c) throw new Error('unreadable fixture');
    expect([c.baseMint, c.quoteMint]).toEqual([SOL_MINT, USDC_MINT]);
    const avg = volumeWeighted(c.rows, 1_791_966_660);
    expect(avg).toBeCloseTo(107.18839062760426, 9);
    expect(orientAverage(c, avg as number, USDC_MINT, SOL_MINT)).toMatchObject({ kind: 'ok', baseMint: SOL_MINT, quoteMint: USDC_MINT });
  });

  it('BAYLA\'s real pool list: the pumpswap BAYLA/SOL pool for BAYLA/SOL, and a dead BAYLA/USDC pool is "thin"', async () => {
    expect(findPairPool(baylaPools, SOL_MINT, BAYLA)).toEqual({
      address: BAYLA_SOL_POOL, baseMint: BAYLA, quoteMint: SOL_MINT, trades24h: 234, volumeUsd24h: 2146.650637774,
    });
    stubFetch(baylaPools, baylaCandles);
    const got = await fetchPairAverage(BAYLA, SOL_MINT, undefined, () => 1_791_960_360_000);
    expect(got.kind === 'ok' && got.price).toBeCloseTo(0.000005153108607396, 17);
    forgetPairAverages();
    expect(await fetchPairAverage(BAYLA, USDC_MINT, undefined, () => 1_791_960_360_000)).toEqual({ kind: 'thin' });
  });

  /** The pool list for any /pools path, the candles for any /ohlcv path. */
  function stubFetch(list: unknown, candles: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'https://memetics.finance').searchParams.get('path') ?? '';
      return new Response(JSON.stringify(path.endsWith('/pools') ? list : candles), { status: 200 });
    }));
  }
});
