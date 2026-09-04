import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MIN_TAPE_REFRESH_SECONDS,
  islandPools,
  readIslandTape,
  type IslandPool,
  type IslandTape,
} from '../lib/copytrade/tape';
import { buildTapeLeaderboard, type TapeLeaderboard } from '../lib/copytrade/tapeLeaderboard';

// The island tape, read once per visit.
//
// NOTHING POLLS. One sequential walk per mount, plus a manual refresh the user
// can trigger no more than once a minute — the same rule usePoolTrades follows,
// for the same reason: a tape that refreshed itself would imply a stream this
// venue does not run, and it would spend a keyless, IP-throttled rate budget on
// a page nobody is looking at.
//
// ─── THE CACHE IS IN MEMORY, AND THAT IS THE POINT ───────────────────────────
//
// A module-level object, not localStorage. It survives an SPA route hop (open a
// bungalow, come back, and the twelve requests are not re-issued) and dies with
// the tab, which is exactly the lifetime a sixty-second read deserves. A
// localStorage cache would need a decoder, a version, an eviction rule and a
// staleness story — four more places to be wrong for a value that is worthless
// on the next visit anyway.
//
// ─── FIVE STATES, BECAUSE 'PARTIAL' IS NOT 'READY' AND NOT 'BROKEN' ──────────
//
// With twelve keyless requests, some passes come back with nine. That is not a
// failure and it is not a complete read: `partial` carries it up so the surface
// can draw the board it does have while naming the pools it does not. `unavailable`
// is the all-unread case, and the board is null there — never an empty table.

export type IslandTapeStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'unavailable';

export interface UseIslandTapeOptions {
  /** Addresses to leave off the board — the viewer's own. */
  exclude?: readonly string[];
  /** Pools to walk. Defaults to the registry; injected by tests. */
  pools?: readonly IslandPool[];
  /** Injection seams for tests; production uses the real transport and clock. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** False parks the hook without a request. Used by nothing yet; kept honest. */
  enabled?: boolean;
}

export interface IslandTapeState {
  status: IslandTapeStatus;
  tape: IslandTape | null;
  /** Null whenever a board would be a claim rather than a measurement. */
  board: TapeLeaderboard | null;
  /** One sentence naming what could not be read. Null when everything could. */
  detail: string | null;
  refresh: () => void;
  /**
   * Unix ms when `refresh` will actually do something, or null when it will now.
   * Exposed so the button can say why it is refusing rather than looking broken.
   */
  refreshAvailableAt: number | null;
}

interface CacheEntry {
  tape: IslandTape;
  /** Wall clock (ms) of the read. Also what the refresh gate compares against. */
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
/** One in-flight walk per tab: two panels mounting at once must not double the requests. */
let inFlight: Promise<IslandTape> | null = null;

/** Tests share a module instance; without this, one test's read feeds the next. */
export function __resetIslandTapeCacheForTests(): void {
  cache = null;
  inFlight = null;
}

function statusOf(tape: IslandTape): Exclude<IslandTapeStatus, 'idle' | 'loading'> {
  const read = tape.reads.filter((r) => r.status === 'read').length;
  if (read === 0) return 'unavailable';
  return read === tape.reads.length ? 'ready' : 'partial';
}

function detailOf(tape: IslandTape): string | null {
  const unread = tape.reads.filter((r) => r.status !== 'read');
  if (unread.length === 0) return null;
  const total = tape.reads.length;
  const named = unread
    .map((r) => (r.status === 'unread' ? `${r.pool.label} (${r.reason})` : r.pool.label))
    .join(' · ');
  const throttled = tape.stoppedEarly
    ? ' The feed began rate-limiting part-way through, so the pools after that point were never asked.'
    : '';
  return `${total - unread.length} of ${total} island pools answered. Not read: ${named}.${throttled}`;
}

export function useIslandTape(opts: UseIslandTapeOptions = {}): IslandTapeState {
  const { exclude, pools, fetchImpl, sleep, now, enabled = true } = opts;

  const poolList = useMemo(() => pools ?? islandPools(), [pools]);

  const [tape, setTape] = useState<IslandTape | null>(() => cache?.tape ?? null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [refreshAvailableAt, setRefreshAvailableAt] = useState<number | null>(null);
  const mounted = useRef(true);

  // The injected transport and clock live in a REF, not in the effect's deps.
  // A caller that writes `now={() => clock}` inline hands a new function every
  // render, and a dependency on that identity turns "one walk per mount" into a
  // walk per render — twelve requests each time, against a rate limit that is
  // the binding constraint on this whole page. The deps below are the only
  // things that should actually cause a re-read.
  const seams = useRef({ fetchImpl, sleep, now });

  // Declared BEFORE the walk effect on purpose: effects run in declaration
  // order, so the seams are current by the time the walk reads them on mount.
  useEffect(() => {
    seams.current = { fetchImpl, sleep, now };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const clock = seams.current.now ?? Date.now;
    const fresh = cache !== null && clock() - cache.fetchedAt < MIN_TAPE_REFRESH_SECONDS * 1000;
    if (fresh) {
      setTape(cache!.tape);
      return;
    }

    let cancelled = false;
    setLoading(true);

    // A second mount while a walk is running JOINS it rather than starting
    // another. Two concurrent walks would double the request count against a
    // rate limit that is already the binding constraint here.
    const walk =
      inFlight ??
      (inFlight = readIslandTape(poolList, {
        fetchImpl: seams.current.fetchImpl,
        sleep: seams.current.sleep,
        now: clock,
      }).then((result) => {
        cache = { tape: result, fetchedAt: clock() };
        inFlight = null;
        return result;
      }));

    void walk.then((result) => {
      if (cancelled || !mounted.current) return;
      setTape(result);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // `poolList` is memoised on the caller's array identity; the registry's is stable.
  }, [enabled, nonce, poolList]);

  const refresh = useCallback(() => {
    const clock = seams.current.now ?? Date.now;
    const readyAt = (cache === null ? 0 : cache.fetchedAt) + MIN_TAPE_REFRESH_SECONDS * 1000;
    if (clock() < readyAt) {
      // Refused, and the refusal is VISIBLE. A button that silently does nothing
      // teaches a reader that the page is broken; this one says when it is armed.
      setRefreshAvailableAt(readyAt);
      return;
    }
    setRefreshAvailableAt(null);
    cache = null;
    setNonce((n) => n + 1);
  }, []);

  const board = useMemo(() => (tape === null ? null : buildTapeLeaderboard(tape, { exclude })), [tape, exclude]);

  const status: IslandTapeStatus = tape === null ? (loading ? 'loading' : 'idle') : statusOf(tape);

  return {
    status,
    tape,
    // Belt and braces with buildTapeLeaderboard's own null: a board must never
    // render from a read where nothing was read.
    board: status === 'unavailable' ? null : board,
    detail: tape === null ? null : detailOf(tape),
    refresh,
    refreshAvailableAt,
  };
}
