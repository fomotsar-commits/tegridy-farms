// What the hook must not let a caller do with a chart.
//
// Two failures live here and nowhere else. The first is the shared one: an
// outage must not arrive as an empty series, because an empty series draws as a
// pool that never traded. The second is specific to this hook — the timeframe
// is a rendering parameter, not a query parameter, so switching it must actually
// re-bucket. A chart that relabels its axis "1D" while still holding hourly
// candles is a chart asserting a resolution it does not have, and it would look
// completely normal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { indexerQueryMock, isIndexerConfiguredMock } = vi.hoisted(() => ({
  indexerQueryMock: vi.fn(),
  isIndexerConfiguredMock: vi.fn(),
}));

vi.mock('../lib/indexer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/indexer/client')>();
  return {
    ...actual,
    indexerQuery: indexerQueryMock,
    isIndexerConfigured: isIndexerConfiguredMock,
  };
});

import { IndexerUnavailableError } from '../lib/indexer/client';
import type { PairPricing } from '../lib/chart/pairSwaps';
import { useChartCandles } from './useChartCandles';

const PAIR = '0x00000000000000000000000000000000000000aa';
const E18: PairPricing = { base: 'token0', token0Decimals: 18, token1Decimals: 18 };
const READY = { ready: true, syncedBlock: 25_300_000, syncedAt: 1_780_000_100 };
const SYNCING = { ready: false, syncedBlock: 25_000_000, syncedAt: 1_770_000_000 };

const HOUR = 3600;
const BASE_TS = 1_780_000_000 - (1_780_000_000 % 86_400);

/** One swap of `base` token0 for `quote` token1 at `hourOffset` hours past BASE_TS. */
function swap(hourOffset: number, base: bigint, quote: bigint, id = `s${hourOffset}`) {
  return {
    id,
    type: 'swap',
    pair: PAIR,
    amount0In: 0n,
    amount1In: quote,
    amount0Out: base,
    amount1Out: 0n,
    timestamp: BigInt(BASE_TS + hourOffset * HOUR),
  };
}

function answer(items: unknown[], meta: unknown, hasNextPage = false) {
  return { data: { pairEvents: { items, pageInfo: { hasNextPage, endCursor: null } } }, meta };
}

const ONE = 10n ** 18n;

beforeEach(() => {
  indexerQueryMock.mockReset();
  isIndexerConfiguredMock.mockReset();
  isIndexerConfiguredMock.mockReturnValue(true);
  vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useChartCandles — nothing to chart', () => {
  it('parks in idle without asking, when no pair is given', async () => {
    const { result } = renderHook(() => useChartCandles({ pair: null, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(indexerQueryMock).not.toHaveBeenCalled();
    expect(result.current.series).toBeNull();
  });

  it('is unavailable, with a null series, when there is no indexer', async () => {
    isIndexerConfiguredMock.mockReturnValue(false);
    const { result } = renderHook(() => useChartCandles({ pair: PAIR, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(indexerQueryMock).not.toHaveBeenCalled();
    // Null, not an empty series. An empty series has slots to render and a
    // caller could draw it; null has nothing and cannot be drawn by accident.
    expect(result.current.series).toBeNull();
    expect(result.current.detail).toBeTruthy();
  });

  it('keeps the series null through an outage instead of returning zero candles', async () => {
    indexerQueryMock.mockRejectedValue(
      new IndexerUnavailableError('unreachable', 'The indexer did not answer in time.'),
    );
    const { result } = renderHook(() => useChartCandles({ pair: PAIR, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.series).toBeNull();
    expect(result.current.swapsRead).toBe(0);
  });
});

describe('useChartCandles — a ready answer', () => {
  it('builds candles with the empty hours between them kept as gaps', async () => {
    indexerQueryMock.mockResolvedValue(
      answer([swap(0, ONE, ONE), swap(4, ONE, 2n * ONE)], READY),
    );
    const { result } = renderHook(() => useChartCandles({ pair: PAIR, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const series = result.current.series!;
    expect(series.slots.map((s) => s.kind)).toEqual(['candle', 'gap', 'candle']);
    expect(series.emptyBuckets).toBe(3);
    expect(series.candleCount).toBe(2);
    expect(result.current.swapsRead).toBe(2);
  });

  it('counts rows it could not price rather than shortening the series in silence', async () => {
    indexerQueryMock.mockResolvedValue(
      answer(
        [
          swap(0, ONE, ONE),
          // A mint row: no priceable legs. It must not vanish without a number.
          { ...swap(1, 0n, 0n, 'mint'), type: 'mint', amount1In: null, amount0Out: null },
        ],
        READY,
      ),
    );
    const { result } = renderHook(() => useChartCandles({ pair: PAIR, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.unpriceable).toBe(1);
    expect(result.current.series!.candleCount).toBe(1);
  });

  it('drops the oldest bucket when older swaps exist behind the page, and reports both', async () => {
    indexerQueryMock.mockResolvedValue(
      answer([swap(0, ONE, ONE), swap(1, ONE, 2n * ONE)], READY, true),
    );
    const { result } = renderHook(() => useChartCandles({ pair: PAIR, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.truncated).toBe(true);
    expect(result.current.series!.droppedOldestBucket).toBe(true);
    expect(result.current.series!.candleCount).toBe(1);
  });

  it('reports backfilling separately — the rows are real but the history is a prefix', async () => {
    indexerQueryMock.mockResolvedValue(answer([swap(0, ONE, ONE)], SYNCING));
    const { result } = renderHook(() => useChartCandles({ pair: PAIR, pricing: E18, timeframe: '1h' }));
    await waitFor(() => expect(result.current.status).toBe('backfilling'));
    expect(result.current.detail).toBeTruthy();
  });
});

describe('useChartCandles — the timeframe actually re-buckets', () => {
  it('recomputes the candles on a timeframe change without refetching', async () => {
    indexerQueryMock.mockResolvedValue(
      answer([swap(0, ONE, ONE), swap(1, ONE, 2n * ONE), swap(2, ONE, 3n * ONE)], READY),
    );

    const { result, rerender } = renderHook(
      ({ tf }: { tf: '1h' | '1d' }) => useChartCandles({ pair: PAIR, pricing: E18, timeframe: tf }),
      { initialProps: { tf: '1h' as const } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.series!.candleCount).toBe(3);

    rerender({ tf: '1d' });
    await waitFor(() => expect(result.current.series!.candleCount).toBe(1));

    // Three hourly candles collapsing into one daily one is the whole test. If
    // the bucket size were captured at fetch time this would still read 3 while
    // the UI's "1D" button showed pressed.
    const daily = result.current.series!.slots[0];
    if (daily.kind !== 'candle') throw new Error('unreachable');
    expect(daily.open).toBe(1);
    expect(daily.close).toBe(3);
    expect(daily.trades).toBe(3);

    // And it did not go back to the network to do it — the rows were already read.
    expect(indexerQueryMock).toHaveBeenCalledTimes(1);
  });
});
