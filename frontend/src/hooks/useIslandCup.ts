import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cupPools,
  type CupBoard,
  type CupPool,
  type PoolCoverage,
} from '../lib/competitions/islandCup';
import { readIslandCup } from '../lib/competitions/islandCupSource';

// The Island Cup board, read once per mount.
//
// NOTHING POLLS. Same rule as usePoolTrades and usePoolMarket: one read when the
// view appears, plus a button the reader presses. A board that refreshed itself
// would imply a stream this venue does not run, and would spend a shared,
// throttled rate limit on nobody's behalf.
//
// A `reload()` inside the shared 60-second TTL is honest about being cheap: it
// re-runs the read, every pool answers out of lib/geckoTerminal/poolTrades'
// cache, and the same `newestFillAt` comes back. It does not fabricate movement.
//
// THE BOARD IS NULL UNLESS SOMETHING ANSWERED. `board` is non-null only in
// 'complete' and 'partial', so a page cannot draw a table over an outage — an
// empty leaderboard under a season name says nobody entered, about everyone at
// once. `coverage` is returned SEPARATELY and survives that: when nothing could
// be read, the page still owes the reader the list of pools and the reason each
// one failed, which is the difference between an outage and a quiet market.
//
// This file contains no `fetch(`, no clock read and no interval. Time comes from
// the fills themselves, which is the only time this board is entitled to print.

export type IslandCupStatus = 'idle' | 'loading' | 'complete' | 'partial' | 'unavailable';

export interface IslandCupState {
  status: IslandCupStatus;
  /** Non-null only in 'complete' and 'partial'. */
  board: CupBoard | null;
  /** Per-pool outcome of the last completed read. Empty before the first one. */
  coverage: PoolCoverage[];
  poolsTotal: number;
  reload: () => void;
}

export interface UseIslandCupOptions {
  /** Override the registry list. Tests only — production reads the registry. */
  pools?: readonly CupPool[];
  /** Injection seam for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  enabled?: boolean;
}

export function useIslandCup(opts: UseIslandCupOptions = {}): IslandCupState {
  const { pools: given, fetchImpl, ttlMs, enabled = true } = opts;

  // Resolved once per mount so the effect below has a stable dependency: calling
  // cupPools() inline would build a new array on every render and re-read the
  // feed on every render with it.
  const pools = useMemo(() => (given ? [...given] : cupPools()), [given]);

  const [status, setStatus] = useState<IslandCupStatus>('idle');
  const [lastBoard, setLastBoard] = useState<CupBoard | null>(null);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || pools.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    queueMicrotask(async () => {
      if (cancelled) return;
      setStatus('loading');
      const read = await readIslandCup(pools, {
        signal: controller.signal,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });
      if (cancelled) return;
      setStatus(read.status);
      setLastBoard(read.board);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pools, fetchImpl, ttlMs, enabled, nonce]);

  return useMemo(() => {
    const scoreable = status === 'complete' || status === 'partial';
    return {
      status,
      board: scoreable ? lastBoard : null,
      coverage: lastBoard ? lastBoard.coverage : [],
      poolsTotal: pools.length,
      reload,
    };
  }, [status, lastBoard, pools.length, reload]);
}
