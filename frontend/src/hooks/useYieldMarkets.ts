import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  YieldFeedUnavailableError,
  fetchYieldFeed,
  isYieldFeedConfigured,
  venueReading,
  yieldFeedConfigProblem,
  type YieldFeedDocument,
} from '../lib/yield/feed';
import { rankByApy, venueMetrics, type VenueMetrics, type YieldRanking } from '../lib/yield/metrics';
import { yieldVenues, type YieldVenueKind } from '../lib/yield/venues';

// The comparison table's state machine.
//
// THREE STATES, and the third is the one this exists for. A two-state hook
// (loading / data) cannot express "we could not ask", and that failure renders as
// a table of zeroes — the most persuasive wrong answer a yield surface can give,
// because a 0.00% APY beside a 1.00 peg looks like a considered reading.
//
// `rows` is ALWAYS the full catalogue, in every state including `unavailable`.
// That is deliberate and is the opposite of the indexer hooks' empty-list
// discipline, for a reason specific to this data: the catalogue is static local
// knowledge — who the counterparty is, what the loss mode is — and none of it
// depends on the feed. Hiding those rows during an outage would delete the
// honest half of the page to protect the unread half. What the outage removes is
// the NUMBERS, and each cell says so on its own behalf.

export interface YieldMarketsState {
  status: 'loading' | 'ready' | 'unavailable';
  /** Every venue in the catalogue, whether or not anything was read for it. */
  rows: VenueMetrics[];
  /** Unix seconds the feed took its readings, or null when nothing was read. */
  asOf: number | null;
  /** Plain-language reason. Set in `unavailable`; null when the read succeeded. */
  detail: string | null;
  reload: () => void;
}

interface FeedState {
  status: 'loading' | 'ready' | 'unavailable';
  doc: YieldFeedDocument | null;
  detail: string | null;
  /**
   * Unix seconds at which the answer landed.
   *
   * Captured once per fetch rather than read from the clock on every render:
   * staleness derived from a live clock would make every cell's detail string a
   * new value each tick, re-render the whole table, and still not tell a reader
   * anything the age words do not.
   */
  readAt: number;
}

export function useYieldMarkets(): YieldMarketsState {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const [feed, setFeed] = useState<FeedState>(() => ({
    status: 'loading',
    doc: null,
    detail: null,
    readAt: Math.floor(Date.now() / 1000),
  }));

  useEffect(() => {
    // Asked before any network call so an unconfigured deployment never emits a
    // request and never shows a spinner it cannot resolve.
    if (!isYieldFeedConfigured()) {
      setFeed({
        status: 'unavailable',
        doc: null,
        detail:
          yieldFeedConfigProblem() ??
          'This deployment publishes no yield feed, so no rate, peg or exit-liquidity figure was read. Nothing below is a statement about what these venues pay.',
        readAt: Math.floor(Date.now() / 1000),
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setFeed((prev) => ({ ...prev, status: 'loading', detail: null }));

    (async () => {
      try {
        const doc = await fetchYieldFeed({ signal: controller.signal });
        if (cancelled || controller.signal.aborted) return;
        setFeed({ status: 'ready', doc, detail: null, readAt: Math.floor(Date.now() / 1000) });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setFeed({
          status: 'unavailable',
          doc: null,
          detail:
            err instanceof YieldFeedUnavailableError
              ? err.message
              : 'The yield feed could not be read. Nothing below is a statement about what these venues pay.',
          readAt: Math.floor(Date.now() / 1000),
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey]);

  const rows = useMemo(
    () =>
      yieldVenues().map((venue) =>
        venueMetrics(venue, venueReading(feed.doc, venue.id), feed.doc?.asOf ?? null, feed.readAt),
      ),
    [feed.doc, feed.readAt],
  );

  return {
    status: feed.status,
    rows,
    asOf: feed.doc?.asOf ?? null,
    detail: feed.detail,
    reload,
  };
}

/**
 * One panel's slice of the catalogue, plus its ranking.
 *
 * Pure and exported from the hook module so both panels rank through the same
 * code path: a second ranking helper is a second chance for one surface to call
 * something "the best rate" on evidence the other would have refused.
 */
export function marketsForKind(
  rows: readonly VenueMetrics[],
  kind: YieldVenueKind | readonly YieldVenueKind[],
): { rows: VenueMetrics[]; ranking: YieldRanking } {
  const kinds = typeof kind === 'string' ? [kind] : kind;
  const scoped = rows.filter((r) => kinds.includes(r.venue.kind));
  return { rows: scoped, ranking: rankByApy(scoped) };
}
