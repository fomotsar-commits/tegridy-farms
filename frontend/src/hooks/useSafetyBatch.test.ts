import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DistributionAnalysis } from '../lib/detection';
import type { MarketRow } from '../lib/geckoTerminal/pools';
import { isKnownSafe } from '../lib/terminal/rowSafety';

// THE BATCH IS THE ONE PLACE THIS PAGE IS ALLOWED TO MULTIPLY ITS UPSTREAM, so
// every one of its three brakes is pinned, and so is the thing it must never
// produce.
//
//   LIMIT   — five, no matter how many rows are visible.
//   SPACING — at least 1.5s apart, sequentially. A parallel burst against a
//             keyless API manufactures the 429 it would then report.
//   ABORT   — the first `unavailable`/`rate-limited` upstream stops the run and
//             is NAMED. Continuing turns one refusal into five and teaches the
//             reader that four more tokens are unreadable, which is a claim
//             about the tokens rather than about the source.
//
// And the negative: NO batch result can ever be `isKnownSafe`. That is
// structural — the deployer component is unread by construction here — but a
// paragraph is not a test.

// vi.hoisted: vi.mock is lifted above every const in this file, and the factory
// below evaluates `scanTokenLive: scanMock` eagerly. Without this the module
// mock reads an uninitialised binding.
const scanMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/scanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/scanner')>();
  // ScanError must stay the REAL class: the abort branch is an `instanceof`
  // check, and a stubbed error class would make it silently unreachable.
  return { ...actual, scanTokenLive: scanMock };
});

import { ScanError } from '../lib/scanner';
import { SAFETY_BATCH_GAP_MS, SAFETY_BATCH_LIMIT, useSafetyBatch } from './useSafetyBatch';

function row(i: number, network: MarketRow['network'] = 'eth'): MarketRow {
  const hex = i.toString(16).padStart(40, '0');
  return {
    key: `${network}:0x${hex}`,
    network,
    pool: `0x${hex}`,
    token: `0x${(i + 1000).toString(16).padStart(40, '0')}`,
    quoteToken: null,
    name: `row ${i}`,
    dex: null,
    createdAt: null,
    priceUsd: null,
    liquidityUsd: null,
    fdvUsd: null,
    volume24hUsd: null,
    change24hPct: null,
    tx24h: null,
    tx5m: null,
    withheld: true,
  };
}

/** A holder read that came back CLEAN — the most dangerous input for this hook. */
function cleanAnalysis(): DistributionAnalysis {
  return {
    band: 'well-distributed',
    confidence: { level: 'high' },
    gate: { findings: [] },
  } as unknown as DistributionAnalysis;
}

function concentratedAnalysis(): DistributionAnalysis {
  return {
    band: 'concentrated',
    confidence: { level: 'high' },
    gate: { findings: [{ id: 'top1-share', fired: true }] },
  } as unknown as DistributionAnalysis;
}

beforeEach(() => {
  scanMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the three brakes', () => {
  it('reads exactly five rows out of twenty', async () => {
    scanMock.mockResolvedValue({ analysis: cleanAnalysis() });
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run(rows));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 25);
    });

    expect(scanMock).toHaveBeenCalledTimes(SAFETY_BATCH_LIMIT);
    expect(result.current.progress.total).toBe(SAFETY_BATCH_LIMIT);
  });

  it('spaces the reads at least the full gap apart, sequentially', async () => {
    const times: number[] = [];
    scanMock.mockImplementation(async () => {
      times.push(Date.now());
      return { analysis: cleanAnalysis() };
    });
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run(Array.from({ length: 5 }, (_, i) => row(i))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });

    expect(times).toHaveLength(5);
    for (let i = 1; i < times.length; i += 1) {
      // A `Promise.all` rewrite — the obvious "make it faster" change — puts
      // every one of these at the same millisecond and fails here.
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(SAFETY_BATCH_GAP_MS);
    }
  });

  it('stops at the first refusing upstream and NAMES it', async () => {
    scanMock
      .mockResolvedValueOnce({ analysis: concentratedAnalysis() })
      .mockRejectedValueOnce(new ScanError('rate-limited', 'Too many requests.'))
      .mockResolvedValue({ analysis: cleanAnalysis() });

    const { result } = renderHook(() => useSafetyBatch());
    act(() => result.current.run(Array.from({ length: 5 }, (_, i) => row(i))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });

    expect(scanMock).toHaveBeenCalledTimes(2);
    expect(result.current.progress.stoppedBy).toMatch(/holder data source/i);
    expect(result.current.progress.stoppedBy).toMatch(/rate-limited/i);
    // The row it DID read keeps its finding; the three it never reached have no
    // entry at all, which the page renders as unscored — not as clean.
    expect(result.current.results.size).toBe(1);
    expect(result.current.progress.done).toBe(1);
  });

  it('also stops on an `unavailable` source, not only on a rate limit', async () => {
    scanMock.mockRejectedValue(new ScanError('unavailable', 'Not enabled on this deployment.'));
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run(Array.from({ length: 5 }, (_, i) => row(i))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });

    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(result.current.progress.stoppedBy).toMatch(/unavailable/i);
  });

  it('a per-TOKEN failure is not a source failure — the run continues, that row unscored', async () => {
    // The distinction the abort depends on. `not-found` says something about one
    // token; treating it as a source outage would stop the batch for no reason.
    scanMock
      .mockRejectedValueOnce(new ScanError('not-found', 'No holder data for this token.'))
      .mockResolvedValue({ analysis: cleanAnalysis() });

    const { result } = renderHook(() => useSafetyBatch());
    act(() => result.current.run(Array.from({ length: 3 }, (_, i) => row(i))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });

    expect(scanMock).toHaveBeenCalledTimes(3);
    expect(result.current.progress.stoppedBy).toBeNull();
    expect(result.current.results.size).toBe(3);
  });

  it('abort() halts a run in flight', async () => {
    scanMock.mockResolvedValue({ analysis: cleanAnalysis() });
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run(Array.from({ length: 5 }, (_, i) => row(i))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS);
    });
    act(() => result.current.abort());
    const calls = scanMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });
    expect(scanMock.mock.calls.length).toBe(calls);
  });
});

describe('a batch result can never be a pass', () => {
  it('not even when every holder read comes back perfectly clean', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. The deployer half is unread on every
    // row here by construction, so `coverage` can never be 'complete' — and
    // `isKnownSafe` requires exactly that. A future change that supplied a
    // placeholder deployer "to make the batch useful" fails here.
    scanMock.mockResolvedValue({ analysis: cleanAnalysis() });
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run(Array.from({ length: 5 }, (_, i) => row(i))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });

    expect(result.current.results.size).toBe(5);
    for (const [, safety] of result.current.results) {
      expect(isKnownSafe(safety)).toBe(false);
      // A clean holder read with an unread deployer is UNSCORED, not clean.
      expect(safety.kind).toBe('unscored');
    }
  });

  it('a concentrated read DOES surface, as high risk and partly unread', async () => {
    // The other half of the asymmetry: the gap must not erase the finding
    // either, or the batch would be a button that reports nothing.
    scanMock.mockResolvedValue({ analysis: concentratedAnalysis() });
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run([row(1)]));
    // Fake timers are installed, so `waitFor`'s own polling would never tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS);
    });
    expect(result.current.results.size).toBe(1);

    const safety = result.current.results.get(row(1).key);
    expect(safety?.kind).toBe('scored');
    expect(safety && safety.kind === 'scored' && safety.observed).toBe('high-risk');
    expect(safety && safety.kind === 'scored' && safety.coverage).toBe('partial');
    expect(safety && isKnownSafe(safety)).toBe(false);
  });
});

describe('each row is scanned on its own chain', () => {
  it('forces the Base override and leaves the other two alone', async () => {
    scanMock.mockResolvedValue({ analysis: cleanAnalysis() });
    const rows = [row(1, 'eth'), row(2, 'base'), row(3, 'solana')];
    const { result } = renderHook(() => useSafetyBatch());

    act(() => result.current.run(rows));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_BATCH_GAP_MS * 10);
    });

    expect(scanMock.mock.calls[0]?.[1]).toMatchObject({ chainOverride: undefined });
    expect(scanMock.mock.calls[1]?.[1]).toMatchObject({ chainOverride: 'base' });
    expect(scanMock.mock.calls[2]?.[1]).toMatchObject({ chainOverride: undefined });
  });
});
