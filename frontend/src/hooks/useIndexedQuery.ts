import { useCallback, useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import {
  INDEXER_META_SELECTION,
  IndexerUnavailableError,
  indexerQuery,
  isIndexerConfigured,
  indexerConfigProblem,
  type IndexerMeta,
} from '../lib/indexer/client';

// Shared state machine behind every useIndexed* hook.
//
// The whole point is the FIVE states. A two-state (loading / data) hook cannot
// express the two failures that matter here, and both of them render as a
// convincing zero if they are not given a name of their own:
//
//   unavailable  — we could not ask, or could not trust the answer. Nothing
//                  below is about the chain. `items` is empty because there is
//                  no answer, NOT because there is no history.
//   backfilling  — the indexer answered and is still replaying history from
//                  block 25263328. What came back is a PREFIX of the truth, so
//                  an empty page here means nothing at all.
//
// A caller that renders `items` without branching on `status` will show an
// empty list in both cases. That is the failure this file exists to make
// impossible to reach by accident, which is why `items` is empty in every
// non-`ready` state rather than partially populated.

export type IndexedStatus =
  /** Nothing asked for yet (the hook is disabled, or its inputs are absent). */
  | 'idle'
  | 'loading'
  /** The indexer answered, historical sync is complete: `items` is the answer. */
  | 'ready'
  /** The indexer answered but is still backfilling: `items` is incomplete. */
  | 'backfilling'
  /** No usable answer. `items` is empty and says nothing about the chain. */
  | 'unavailable';

export interface IndexedQueryState<Row> {
  status: IndexedStatus;
  /** Non-empty only in `ready` and `backfilling`. */
  items: Row[];
  /** More rows exist past this page. */
  hasMore: boolean;
  /** Head block the indexer had reached, or null when it did not report one. */
  syncedBlock: number | null;
  /** Unix seconds of that block. Lets a surface state its own lag honestly. */
  syncedAt: number | null;
  /** Plain-language reason, set in `unavailable` and `backfilling`. */
  detail: string | null;
  reload: () => void;
}

const BACKFILL_DETAIL =
  'The indexer is still replaying history, so this list is incomplete — an empty result here does not mean there is nothing.';

const UNKNOWN_FRESHNESS_DETAIL =
  'The indexer did not report its sync position, so how complete this list is cannot be established.';

export interface UseIndexedQueryOptions<Data, Row> {
  query: string;
  /**
   * Must be JSON-serialisable — it is both the request body and the effect's
   * dependency key. uint256 filters travel as decimal strings for this reason
   * as much as for the scalar's; see the `*Variables` builders in
   * lib/indexer/queries.ts, which are the supported way to construct this.
   */
  variables: Record<string, unknown>;
  schema: z.ZodType<Data>;
  /** Pull the rows and the has-more flag out of the validated response. */
  select: (data: Data) => { items: Row[]; hasNextPage: boolean };
  /** False parks the hook in `idle` without asking anything. */
  enabled?: boolean;
}

function emptyState<Row>(status: IndexedStatus, detail: string | null): Omit<IndexedQueryState<Row>, 'reload'> {
  return { status, items: [], hasMore: false, syncedBlock: null, syncedAt: null, detail };
}

/**
 * How a successful response becomes a state.
 *
 * Exported and pure so the gating rule is testable without a render: the
 * decision that "answered but not ready" is its own state — never `ready`, and
 * never silently downgraded to `unavailable` either, because the rows that DID
 * come back are real — is the honesty rule of this module, and a refactor that
 * loses it should fail a test rather than a review.
 */
export function classifyResponse<Row>(
  items: Row[],
  hasNextPage: boolean,
  meta: IndexerMeta | null,
): Omit<IndexedQueryState<Row>, 'reload'> {
  // No meta at all: the indexer did not say where it is, so we cannot claim the
  // list is complete. Treat unknown freshness exactly like a known backfill.
  const ready = meta?.ready === true;
  return {
    status: ready ? 'ready' : 'backfilling',
    items,
    hasMore: hasNextPage,
    syncedBlock: meta?.syncedBlock ?? null,
    syncedAt: meta?.syncedAt ?? null,
    detail: ready ? null : meta ? BACKFILL_DETAIL : UNKNOWN_FRESHNESS_DETAIL,
  };
}

export function useIndexedQuery<Data, Row>(
  opts: UseIndexedQueryOptions<Data, Row>,
): IndexedQueryState<Row> {
  const { query, schema, select, enabled = true } = opts;

  // Structural key: the effect must re-run when a filter value changes, not
  // when a caller happens to rebuild the same object literal on every render.
  const variablesKey = JSON.stringify(opts.variables);
  const variables = useMemo(() => JSON.parse(variablesKey) as Record<string, unknown>, [variablesKey]);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const [state, setState] = useState<Omit<IndexedQueryState<Row>, 'reload'>>(() =>
    emptyState<Row>('idle', null),
  );

  useEffect(() => {
    if (!enabled) {
      setState(emptyState<Row>('idle', null));
      return;
    }

    // Asked before any network call so an unconfigured deployment never emits a
    // request and never shows a spinner it cannot resolve.
    if (!isIndexerConfigured()) {
      setState(
        emptyState<Row>(
          'unavailable',
          indexerConfigProblem() ??
            'This deployment has no indexer configured, so indexed history is not available. Nothing here is a statement about the chain.',
        ),
      );
      return;
    }

    if (!query.includes(INDEXER_META_SELECTION)) {
      // A document without `_meta` cannot be gated for freshness, so the only
      // honest thing to do with its rows is refuse them. Caught in tests; this
      // is the runtime backstop.
      setState(
        emptyState<Row>(
          'unavailable',
          'This query cannot report the indexer’s sync position, so its result is not trusted.',
        ),
      );
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState(emptyState<Row>('loading', null));

    (async () => {
      try {
        const { data, meta } = await indexerQuery({
          query,
          variables,
          schema,
          signal: controller.signal,
        });
        if (cancelled || controller.signal.aborted) return;
        const { items, hasNextPage } = select(data);
        setState(classifyResponse<Row>(items, hasNextPage, meta));
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const detail =
          err instanceof IndexerUnavailableError
            ? err.message
            : 'The indexed history could not be read. Nothing here is a statement about the chain.';
        setState(emptyState<Row>('unavailable', detail));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `select` and `schema` are stable module-level values at every call site;
    // keying the effect on them would re-fetch on every render of a caller that
    // inlines either one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, variables, enabled, reloadKey]);

  return { ...state, reload };
}
