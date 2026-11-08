import { useCallback, useEffect, useRef, useState } from 'react';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import { optionalReadAllowed } from '../../../lib/solana/lp/rpcBudget';
import type { LpReaders } from './readers';

/**
 * Every pool on the venue (Every position, EveryPosition.tsx), read on mount and again
 * whenever `reloadKey` moves (a liquidity flow finished). A re-read keeps the last answer on
 * screen until the new one arrives; null only before the first answer. All pools and the
 * arbitrage board use `useLivePoolList` below, which reads again on its own.
 */
export function usePoolList(readers: LpReaders, reloadKey: number): PoolListRead | null {
  const [read, setRead] = useState<PoolListRead | null>(null);
  useEffect(() => {
    if (!readers.listPools) return;
    let live = true;
    readers.listPools().then(
      (r) => live && setRead(r),
      (e: unknown) => live && setRead({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [readers, reloadKey]);
  return read;
}

/**
 * How often the list reads again by itself. The pool index and Jupiter's price are each
 * shared at the edge for 30 seconds, so a faster read would get the same answer; one list
 * read is one index GET, two or three chain calls and one token-check call, well inside
 * the proxy's per-tab window (rpcBudget.ts).
 */
export const LIST_REFRESH_MS = 30_000;
/** Read again is held for this long after an answer: the caches are 30 seconds, so a sooner press would read the same figures. */
export const READ_AGAIN_AFTER_MS = 10_000;
/** Past this age the stamp turns amber: the figures are older than two edge shares. */
export const STALE_MS = 60_000;

export interface LivePoolList {
  /** The last read that answered, or the first read's failure; null before the first answer. */
  read: PoolListRead | null;
  /** This device's clock when `read` landed. */
  readAt: number | null;
  /** A later read failed while `read` stands: its reason. Cleared by the next answer. */
  failed: string | null;
  reading: boolean;
  /** The visitor's own press: read now. Refused under the budget floor (`paused` true, nothing read). */
  again(): void;
  paused: boolean;
}

/**
 * The list, kept live: the first read as `usePoolList`, then a read again every
 * LIST_REFRESH_MS while this tab is in view, when no read is in flight and the proxy's
 * budget allows an optional read, and once more when the tab comes back into view stale.
 * A later read that fails keeps the last list and says why (`failed`): an old figure is
 * said as old, never replaced by nothing. A tab that is hidden reads nothing.
 */
export function useLivePoolList(readers: LpReaders, reloadKey: number): LivePoolList {
  const [state, setState] = useState<{ read: PoolListRead | null; readAt: number | null; failed: string | null }>({ read: null, readAt: null, failed: null });
  const [reading, setReading] = useState(false);
  const [paused, setPaused] = useState(false);
  // One read at a time; an answer to an earlier question (other readers, a reload) is dropped.
  const inFlight = useRef(false);
  const question = useRef(0);
  const readAt = useRef<number | null>(null);

  // Whether a list is on screen: a failed read replaces an unread one, and only keeps a list.
  const hasList = useRef(false);

  const run = useCallback((fresh: boolean) => {
    if (!readers.listPools || inFlight.current) return;
    const asked = ++question.current;
    inFlight.current = true;
    setReading(true);
    const land = (r: PoolListRead) => {
      if (asked !== question.current) return;
      inFlight.current = false;
      setReading(false);
      if (r.kind === 'ok' || !hasList.current) {
        hasList.current = r.kind === 'ok';
        readAt.current = Date.now();
        setState({ read: r, readAt: readAt.current, failed: null });
        setPaused(false);
      } else {
        setState((s) => ({ ...s, failed: r.detail }));
      }
    };
    // A fresh read never takes the answer of one already in flight (readers.ts): a finished
    // liquidity flow and a press must see the chain as it is now, not as it was being read.
    readers.listPools(fresh ? { fresh: true } : undefined).then(land, (e: unknown) => land({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
  }, [readers]);

  // The first read shares one already in flight (Every position asks too); one for every finished
  // liquidity flow is fresh, and whatever was in flight is dropped.
  const first = useRef(true);
  useEffect(() => {
    inFlight.current = false;
    run(!first.current);
    first.current = false;
    return () => {
      // Unmounted, or asked again: the answer on its way is no longer wanted. The ref is a
      // counter, not a node: reading it here is the point, so the lint's node rule does not apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      question.current++;
      inFlight.current = false;
    };
  }, [run, reloadKey]);

  useEffect(() => {
    const inView = () => document.visibilityState !== 'hidden';
    const tick = setInterval(() => {
      if (inView() && !inFlight.current && optionalReadAllowed()) run(false);
    }, LIST_REFRESH_MS);
    // Back in view with stale figures: read now rather than at the next tick.
    const woke = () => {
      if (inView() && !inFlight.current && optionalReadAllowed() && (readAt.current === null || Date.now() - readAt.current >= LIST_REFRESH_MS)) run(false);
    };
    document.addEventListener('visibilitychange', woke);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', woke);
    };
  }, [run]);

  const again = useCallback(() => {
    if (inFlight.current) return;
    if (!optionalReadAllowed()) {
      setPaused(true);
      return;
    }
    setPaused(false);
    run(true);
  }, [run]);

  return { read: state.read, readAt: state.readAt, failed: state.failed, reading, again, paused };
}
