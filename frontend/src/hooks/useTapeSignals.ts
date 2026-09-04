import { useEffect, useMemo, useState } from 'react';
import type { FollowConfig } from '../lib/copytrade/follows';
import { planTapeMirrors, type TapeMirrorCandidate } from '../lib/copytrade/tapeMirror';
import type { IslandTape } from '../lib/copytrade/tape';

// Fills by the followed addresses, each already turned into a sized plan or into
// the reason there is none.
//
// ─── WHY THIS HOOK RUNS A CLOCK AND ISSUES NO REQUEST ────────────────────────
//
// The refusal that matters most — `stale-signal` — is a function of the current
// time, so a `now` captured at mount would keep a two-hour-old fill labelled
// "3 minutes ago" for anyone who left the tab open. That is not cosmetic
// staleness: it is the page telling a reader they are about to copy something
// they are not.
//
// So the clock ticks and the plans are re-judged. What does NOT happen on that
// tick is a re-read: the tape's window is anchored by the walk that produced it
// (useIslandTape), and only the judgement about those fills moves. Re-reading on
// a timer would poll a keyless upstream and imply a stream this venue does not
// run.

export const SIGNAL_CLOCK_INTERVAL_MS = 30_000;

/**
 * Unix seconds, re-read on an interval.
 *
 * Its own hook so the two things it is used for — ageing a signal out and
 * nothing else — stay separate from anything that fetches. Nothing here touches
 * the network.
 */
export function useUnixClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface UseTapeSignalsOptions {
  /** The walk's result. Null while it has not landed — no candidates, not zero. */
  tape: IslandTape | null;
  follows: readonly FollowConfig[];
  intervalMs?: number;
}

export interface TapeSignalsState {
  candidates: TapeMirrorCandidate[];
  /** The clock the plans were judged against, as unix seconds. */
  now: number;
}

export function useTapeSignals(opts: UseTapeSignalsOptions): TapeSignalsState {
  const { tape, follows, intervalMs = SIGNAL_CLOCK_INTERVAL_MS } = opts;
  const now = useUnixClock(intervalMs);

  const candidates = useMemo(
    () => (tape === null ? [] : planTapeMirrors(tape, follows, now)),
    [tape, follows, now],
  );

  return { candidates, now };
}
