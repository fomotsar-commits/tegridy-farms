import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_GECKO_TIMEFRAME,
  GECKO_TIMEFRAMES,
  GECKO_TIMEFRAME_IDS,
  barsToSeries,
  isGeckoTimeframeId,
  ohlcvUrlFor,
  readOhlcvBars,
  type OhlcvBar,
} from './ohlcv';

// The reader's job is to be REFUSABLE. Every case below is aimed at a specific
// way a chart lies: a candle drawn for a bucket nobody reported, a refusal that
// reads as an empty market, a repaired bar, a fabricated trade count, a time
// axis bent by an off-grid bucket, or a clock of this page's own standing in for
// the source's as-of.

const HOUR = 3600;

function bar(hourOffset: number, close: number, volume = 5): OhlcvBar {
  return { timeSec: hourOffset * HOUR, open: close, high: close, low: close, close, volume };
}

function envelope(list: number[][], meta?: unknown): unknown {
  return { data: { attributes: { ohlcv_list: list } }, ...(meta === undefined ? {} : { meta }) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GECKO_TIMEFRAMES', () => {
  it('agrees with itself: bucketSeconds is aggregate × the named unit', () => {
    const unit = { minute: 60, hour: 3600, day: 86400 };
    for (const id of GECKO_TIMEFRAME_IDS) {
      const cfg = GECKO_TIMEFRAMES[id];
      // Mutation: change an aggregate without its bucketSeconds and the URL asks
      // for one width while the grid check enforces another — every read would
      // come back off-grid, or worse, pass with a bent axis.
      expect(cfg.aggregate * unit[cfg.apiTf], `${id} is inconsistent`).toBe(cfg.bucketSeconds);
    }
  });

  it('has a default that is one of the offered frames', () => {
    expect(isGeckoTimeframeId(DEFAULT_GECKO_TIMEFRAME)).toBe(true);
    expect(isGeckoTimeframeId('1w')).toBe(false);
    expect(isGeckoTimeframeId('')).toBe(false);
    expect(isGeckoTimeframeId(null)).toBe(false);
  });
});

describe('ohlcvUrlFor', () => {
  const market = { network: 'eth' as const, pool: '0xabc' };

  it('always reads in USD and never asks the source to invent empty buckets', () => {
    const url = ohlcvUrlFor(market, '1h');
    expect(url).toContain('currency=usd');
    // include_empty_intervals would fill the gaps at the SOURCE, with carried
    // prices — the exact fabrication this page exists to refuse. Mutation:
    // add it and this fails.
    expect(url).not.toContain('include_empty_intervals');
    // No paging in this design, so a before_timestamp would silently pin the
    // window to a moment nothing on screen names.
    expect(url).not.toContain('before_timestamp');
  });

  it('builds the documented path and aggregate for each frame', () => {
    expect(ohlcvUrlFor(market, '4h')).toContain('/ohlcv/hour?aggregate=4');
    expect(ohlcvUrlFor(market, '15m')).toContain('/ohlcv/minute?aggregate=15');
    expect(ohlcvUrlFor(market, '1d')).toContain('/ohlcv/day?aggregate=1');
    expect(ohlcvUrlFor(market, '1h')).toContain(
      'https://api.geckoterminal.com/api/v2/networks/eth/pools/0xabc/ohlcv/hour',
    );
  });

  it('percent-encodes both path segments, so a traversal-shaped pool cannot climb out', () => {
    const url = ohlcvUrlFor({ network: 'eth', pool: '../../search/pools?query=x' }, '1h');
    // Mutation: drop encodeURIComponent (what market.ts:ohlcvUrl does with
    // registry-only inputs) and the raw string appears in the path, reaching a
    // different endpoint than the one this page validates the response of.
    expect(url).not.toContain('../../search');
    expect(url).not.toContain('?query=');
    expect(url).toContain('%2F');
    // The one legitimate query string is still the one this file wrote.
    expect(url.split('?')).toHaveLength(2);
  });

  it('never asks for more buckets than the endpoint allows', () => {
    for (const id of GECKO_TIMEFRAME_IDS) {
      const limit = Number(new URL(ohlcvUrlFor(market, id)).searchParams.get('limit'));
      expect(limit).toBeGreaterThanOrEqual(1);
      expect(limit).toBeLessThanOrEqual(1000);
    }
  });
});

describe('readOhlcvBars — failures stay failures', () => {
  const URL_ = ohlcvUrlFor({ network: 'eth', pool: '0xabc' }, '1h');

  it('maps 429 from the STATUS CODE, never from the body', async () => {
    // The real 429 body has no `data` key, so a schema-first reader would call
    // it off-schema — and a caller that treats "off-schema" as "nothing came
    // back" would draw a refused read as an empty market. Mutation: parse
    // before checking the status and this reason changes.
    const fetchFn = vi.fn(async () =>
      jsonResponse({ status: { error_code: 429, error_message: 'rate limited' } }, 429),
    );
    const read = await readOhlcvBars(URL_, fetchFn as unknown as typeof fetch);
    expect(read).toEqual({
      ok: false,
      reason: 'rate-limited',
      httpStatus: 429,
      detail: expect.any(String),
    });
    // Exactly one attempt. A retry here spends more of a shared budget on a
    // refusal that has already been stated.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('separates 404, other HTTP, off-schema and a dead connection', async () => {
    const cases: Array<[Response | Error, string, number | null]> = [
      [jsonResponse({}, 404), 'not-found', 404],
      [jsonResponse({}, 500), 'http', 500],
      [jsonResponse({ data: { attributes: {} } }, 200), 'off-schema', 200],
      [new TypeError('Failed to fetch'), 'network', null],
    ];
    for (const [outcome, reason, httpStatus] of cases) {
      const fetchFn = vi.fn(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      const read = await readOhlcvBars(URL_, fetchFn as unknown as typeof fetch);
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error('unreachable');
      expect(read.reason).toBe(reason);
      expect(read.httpStatus).toBe(httpStatus);
    }
  });

  it('re-throws an abort rather than reporting it as a failed read', async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(readOhlcvBars(URL_, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      'Aborted',
    );
  });

  it('refuses an off-schema body rather than charting string prices', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(envelope([['1000', '1', '1', '1', '1', '1'] as unknown as number[]])),
    );
    const read = await readOhlcvBars(URL_, fetchFn as unknown as typeof fetch);
    expect(read.ok).toBe(false);
  });
});

describe('readOhlcvBars — what it does to the bars it keeps', () => {
  const URL_ = ohlcvUrlFor({ network: 'eth', pool: '0xabc' }, '1h');

  async function read(list: number[][], meta?: unknown) {
    const fetchFn = vi.fn(async () => jsonResponse(envelope(list, meta)));
    const out = await readOhlcvBars(URL_, fetchFn as unknown as typeof fetch);
    if (!out.ok) throw new Error(`expected a successful read, got ${out.reason}`);
    return out;
  }

  it('sorts a newest-first answer into chronological order', async () => {
    const out = await read([
      [2 * HOUR, 3, 3, 3, 3, 1],
      [1 * HOUR, 2, 2, 2, 2, 1],
      [0, 1, 1, 1, 1, 1],
    ]);
    expect(out.bars.map((b) => b.timeSec)).toEqual([0, HOUR, 2 * HOUR]);
  });

  it('keeps the LATER bar of a duplicate timestamp and counts the collision', async () => {
    const out = await read([
      [HOUR, 1, 1, 1, 1, 1],
      [HOUR, 9, 9, 9, 9, 2],
    ]);
    expect(out.bars).toHaveLength(1);
    expect(out.bars[0]?.close).toBe(9);
    // Mutation: silently dedupe without counting, and a restated bucket becomes
    // invisible in the coverage panel.
    expect(out.duplicates).toBe(1);
  });

  it('DROPS an inconsistent bar and counts it — never repairs one', async () => {
    // high 1 with close 5 is internally impossible. The lightweight-charts
    // reader clamps this (high = max(o,h,l,c)) so the plot draws; that invents
    // an OHLC the source never sent. Mutation: clamp here and `rejected`
    // becomes 0 while a fabricated bar reaches the chart.
    const out = await read([
      [0, 1, 1, 1, 1, 1],
      [HOUR, 5, 1, 1, 5, 1],
      [2 * HOUR, 1, 1, 1, 0, 1],
      [3 * HOUR, 1, 1, 1, 1, -3],
    ]);
    expect(out.bars.map((b) => b.timeSec)).toEqual([0]);
    expect(out.rejected).toBe(3);
  });

  it('refuses the WHOLE body when a number is not a number', async () => {
    // NaN is rejected by the shared R080 envelope, so the read fails closed
    // rather than quietly returning the bars around it. Fail-closed is the
    // right side to land on: a body carrying NaN is a body this page cannot
    // vouch for at all. Mutation: loosen the envelope to tolerate it and a
    // broken upstream would draw a partial chart with no disclosure.
    const fetchFn = vi.fn(async () =>
      jsonResponse(envelope([[0, Number.NaN, 1, 1, 1, 1]])),
    );
    const out = await readOhlcvBars(URL_, fetchFn as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('off-schema');
  });

  it('reads base and quote symbols from meta when the source volunteers them, and null when it does not', async () => {
    const withMeta = await read([[0, 1, 1, 1, 1, 1]], {
      base: { symbol: 'TOWELI', address: '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D' },
      quote: { symbol: 'WETH' },
    });
    expect(withMeta.meta).toEqual({
      baseSymbol: 'TOWELI',
      quoteSymbol: 'WETH',
      baseAddress: '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D',
    });

    // Mutation: default the quote symbol to 'WETH' (or to the network's native
    // token) and the axis names a token nobody said was there.
    const without = await read([[0, 1, 1, 1, 1, 1]]);
    expect(without.meta).toEqual({ baseSymbol: null, quoteSymbol: null, baseAddress: null });
  });
});

describe('barsToSeries', () => {
  const opts = { capped: false, duplicates: 0, rejected: 0 };

  it('draws the missing buckets as ONE gap of true width, not as candles', () => {
    const out = barsToSeries([bar(0, 10), bar(4, 20)], HOUR, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Mutation: skip the gap insertion and slots collapse to 2 with
    // emptyBuckets 0 — four hours of no data drawn as two adjacent hours.
    expect(out.series.slots).toHaveLength(3);
    expect(out.series.slots[1]).toEqual({ kind: 'gap', startSec: HOUR, endSec: 4 * HOUR, buckets: 3 });
    expect(out.series.emptyBuckets).toBe(3);
    expect(out.series.candleCount).toBe(2);
  });

  it('refuses a bucket that does not sit on the frame\'s grid', () => {
    // 4h frame with a bar an hour out of phase. Mutation: skip the grid check
    // and the gap walk divides by 14400 to get a fractional bucket count, which
    // geometry then renders as a column of a width nothing on screen explains.
    const out = barsToSeries([bar(0, 1), { ...bar(4, 1), timeSec: 5 * HOUR }], 4 * HOUR, opts);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('off-grid');
    expect(out.detail).toContain('14400');
  });

  it('keeps a zero-volume bucket as a CANDLE and counts it', () => {
    const out = barsToSeries([bar(0, 10, 0), bar(1, 11, 4)], HOUR, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Mutation: reclassify volume===0 as a gap and a price the source published
    // is deleted from the chart. It is drawn, and the count is what the banner
    // discloses instead.
    expect(out.series.candleCount).toBe(2);
    expect(out.series.zeroVolumeBars).toBe(1);
    expect(out.series.emptyBuckets).toBe(0);
  });

  it('never drops the oldest bucket, and says "capped" instead', () => {
    const bars = [bar(0, 1), bar(1, 2), bar(2, 3)];
    const out = barsToSeries(bars, HOUR, { ...opts, capped: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Mutation: apply the swaps-page truncation rule (candles.ts drops the
    // oldest bucket of a cut page) and the left-most bar vanishes with the page
    // claiming it was "cut" — but GeckoTerminal returns whole buckets, so
    // nothing was cut.
    expect(out.series.candleCount).toBe(3);
    expect(out.series.droppedOldestBucket).toBe(false);
    expect(out.series.capped).toBe(true);
    expect(out.series.from).toBe(0);
  });

  it('never fabricates a trade count', () => {
    const out = barsToSeries([bar(0, 10)], HOUR, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const slot of out.series.slots) {
      if (slot.kind !== 'candle') continue;
      // Mutation: `trades: 0` here and every GeckoTerminal candle would claim
      // the source measured no trades in a bucket it published four prices for.
      expect(slot.trades).toBeNull();
    }
  });

  it('takes its as-of from the newest BAR, not from the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-09-02T00:00:00Z'));
    const out = barsToSeries([bar(0, 10), bar(1, 11)], HOUR, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Mutation: Date.now() here and the page's "newest bucket opened …" line
    // would tick forward on its own while the data stood still.
    expect(out.series.newestStartSec).toBe(HOUR);
  });

  it('carries the reader\'s counts through untouched, and reports an empty read honestly', () => {
    const out = barsToSeries([], HOUR, { capped: false, duplicates: 2, rejected: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.series.candleCount).toBe(0);
    expect(out.series.slots).toEqual([]);
    expect(out.series.newestStartSec).toBeNull();
    expect(out.series.duplicates).toBe(2);
    expect(out.series.rejected).toBe(3);
    expect(out.series.from).toBeNull();
  });

  it('refuses a bucket size that is not a positive whole number of seconds', () => {
    expect(() => barsToSeries([bar(0, 1)], 0, opts)).toThrow(RangeError);
    expect(() => barsToSeries([bar(0, 1)], 1.5, opts)).toThrow(RangeError);
  });
});
