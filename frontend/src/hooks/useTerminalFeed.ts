import { useMemo } from 'react';
import {
  TERMINAL_FEED_QUERY,
  assembleFeed,
  terminalFeedDataSchema,
  terminalFeedVariables,
  type TerminalFeed,
  type TerminalFeedData,
} from '../lib/terminal/feed';
import { useIndexedQuery, type IndexedStatus } from './useIndexedQuery';

// The terminal's discovery feed, over the F1 indexer.
//
// THE INDEXER IS NOT HOSTED. With VITE_INDEXER_URL unset this hook parks in
// `unavailable` with the client's own wording and never emits a request — which
// is the correct resting state and the reason the page must say "the feed is not
// available" rather than draw an empty trench. An empty trench on a discovery
// page is a claim that nothing is launching, and that claim would be false every
// second of every day this build has been running.
//
// All five states of useIndexedQuery are passed through unchanged. `feed` is
// null in every one of them except `ready` and `backfilling`, so a caller that
// reads rows without reading status gets nothing to render rather than something
// misleading to render.

/**
 * Re-exported so terminal components depend on THIS hook rather than reaching
 * past it into the shared indexed-query machine. That is also what keeps the
 * `^useIndexed` exemption in hooksAreMounted.test.ts accurate: the shared state
 * machine is still consumed only from within src/hooks.
 */
export type { IndexedStatus };

export const DEFAULT_PAIR_LIMIT = 50;

/**
 * Larger than the pair page on purpose: an event page shorter than the pair page
 * would truncate for almost every pair, and a truncated window turns every
 * activity figure into "unknown" (see PairActivity). This is the ratio that lets
 * a quiet pair be reported as measurably quiet instead of as unread.
 */
export const DEFAULT_EVENT_LIMIT = 100;

export interface UseTerminalFeedOptions {
  pairLimit?: number;
  eventLimit?: number;
  /** False parks the hook in `idle` without asking anything. */
  enabled?: boolean;
}

export interface TerminalFeedState {
  status: IndexedStatus;
  /** Null in every state but `ready` and `backfilling`. */
  feed: TerminalFeed | null;
  /** Head block the indexer had reached, or null when it did not report one. */
  syncedBlock: number | null;
  syncedAt: number | null;
  /** Plain-language reason, set in `unavailable` and `backfilling`. */
  detail: string | null;
  reload: () => void;
}

/**
 * The assembled feed travels as a one-element page.
 *
 * `useIndexedQuery` is a row-list state machine and the feed carries page-level
 * facts (how many pairs the allowlist excluded, whether the event window was
 * truncated) that a row list has nowhere to put. Wrapping keeps ONE state
 * machine — and therefore one place where "unavailable" is decided — instead of
 * a second, parallel fetch whose failure modes would have to be re-argued.
 */
interface FeedPage {
  feed: TerminalFeed;
}

function selectFeed(data: TerminalFeedData): { items: FeedPage[]; hasNextPage: boolean } {
  return {
    items: [{ feed: assembleFeed(data) }],
    hasNextPage: data.indexedPairs.pageInfo.hasNextPage,
  };
}

export function useTerminalFeed(opts: UseTerminalFeedOptions = {}): TerminalFeedState {
  const { pairLimit = DEFAULT_PAIR_LIMIT, eventLimit = DEFAULT_EVENT_LIMIT, enabled = true } = opts;

  const variables = useMemo(
    () => terminalFeedVariables(pairLimit, eventLimit) as unknown as Record<string, unknown>,
    [pairLimit, eventLimit],
  );

  const query = useIndexedQuery<TerminalFeedData, FeedPage>({
    query: TERMINAL_FEED_QUERY,
    variables,
    schema: terminalFeedDataSchema,
    select: selectFeed,
    enabled,
  });

  return {
    status: query.status,
    feed: query.items[0]?.feed ?? null,
    syncedBlock: query.syncedBlock,
    syncedAt: query.syncedAt,
    detail: query.detail,
    reload: query.reload,
  };
}
