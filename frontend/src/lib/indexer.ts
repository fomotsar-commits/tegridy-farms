import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useWatchBlockNumber } from 'wagmi';

/**
 * Tegridy indexer client (P0-2).
 *
 * The Ponder indexer in `indexer/` exposes a GraphQL endpoint per Ponder
 * defaults (path: `/graphql`). The frontend reaches it through one of:
 *
 *   1. `import.meta.env.VITE_INDEXER_URL` — full URL, bundled into the
 *      client. Use for public reads when the indexer is on a CDN/edge.
 *   2. `/api/indexer` — Vercel serverless proxy. Reads `INDEXER_URL` from
 *      server env. Use when the indexer URL should not be public, or
 *      when you want CORS / rate-limit headers managed centrally.
 *   3. Nothing configured — `query()` rejects with INDEXER_UNAVAILABLE
 *      and `useIndexerQuery()` returns `{ isAvailable: false, data:
 *      undefined }`. Call-sites then fall back to RPC / Etherscan.
 *
 * Memory rule: never leak `.env` contents. The full URL only ever lives
 * client-side when the operator explicitly chose `VITE_INDEXER_URL`
 * (acknowledging the URL is public). Default path is the server proxy.
 */

export type IndexerVariables = Record<string, unknown> | undefined;

export type IndexerError = {
  message: string;
  /** Underlying transport error, if any (network failure, abort, etc.). */
  cause?: unknown;
  /** GraphQL `errors[]` from the server when the response was structured. */
  graphqlErrors?: Array<{ message: string; path?: readonly (string | number)[] }>;
};

export class IndexerUnavailableError extends Error {
  readonly code = 'INDEXER_UNAVAILABLE' as const;
  constructor() {
    super('Indexer URL is not configured');
    this.name = 'IndexerUnavailableError';
  }
}

/** Resolve the active indexer endpoint. Returns null when nothing is wired. */
export function resolveIndexerUrl(): string | null {
  // Vite inlines `import.meta.env.VITE_*` at build time. The non-null URL
  // beats the proxy path so a deploy can target a CDN/edge directly.
  const direct = (import.meta.env.VITE_INDEXER_URL ?? '').toString().trim();
  if (direct) return direct;
  // Server-side proxy fallback. The Vercel function returns 503 when
  // INDEXER_URL is unset on the server too; we still hit it because it
  // gives a single canonical "not configured" code path.
  if (import.meta.env.PROD || import.meta.env.DEV) return '/api/indexer';
  return null;
}

/**
 * Lowest-level GraphQL call. Throws `IndexerUnavailableError` when no URL
 * is configured (call-sites use this to switch to a fallback path).
 */
export async function indexerQuery<TData>(
  query: string,
  variables?: IndexerVariables,
  signal?: AbortSignal,
): Promise<TData> {
  const url = resolveIndexerUrl();
  if (!url) throw new IndexerUnavailableError();

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal,
      // Same-origin reads stay credentialed in case the proxy ever adds
      // an auth layer; cross-origin VITE_INDEXER_URL deployments will
      // 0-credential as expected because of the default credentials mode.
    });
  } catch (err) {
    const error: IndexerError = {
      message:
        err instanceof Error && err.name === 'AbortError'
          ? 'Indexer request aborted'
          : 'Indexer network error',
      cause: err,
    };
    throw Object.assign(new Error(error.message), error);
  }

  // Proxy and the upstream both emit 503 for "URL not set". Treat both as
  // unavailable so the React Query side surfaces the same error code.
  if (resp.status === 503) {
    throw new IndexerUnavailableError();
  }

  // The proxy collapses upstream 5xx → 500 with a stable envelope; the
  // upstream itself may return a 200 with a GraphQL `errors` array.
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw Object.assign(new Error(`Indexer returned non-JSON (HTTP ${resp.status})`), {
      message: `Indexer returned non-JSON (HTTP ${resp.status})`,
    } satisfies IndexerError);
  }
  if (typeof json !== 'object' || json === null) {
    throw Object.assign(new Error('Indexer returned a malformed payload'), {
      message: 'Indexer returned a malformed payload',
    } satisfies IndexerError);
  }
  const envelope = json as {
    data?: TData;
    errors?: Array<{ message: string; path?: readonly (string | number)[] }>;
  };
  if (envelope.errors?.length) {
    throw Object.assign(new Error(envelope.errors[0]?.message ?? 'Indexer error'), {
      message: envelope.errors[0]?.message ?? 'Indexer error',
      graphqlErrors: envelope.errors,
    } satisfies IndexerError);
  }
  if (envelope.data === undefined) {
    throw Object.assign(new Error('Indexer returned no data'), {
      message: 'Indexer returned no data',
    } satisfies IndexerError);
  }
  return envelope.data;
}

/**
 * Lightweight availability probe. Cached for 5 minutes via React Query so
 * we don't ping the proxy on every render. Returns `true` only when the
 * URL is set AND the endpoint answers a `__typename` query within 5s.
 */
export function useIndexerAvailability() {
  const url = resolveIndexerUrl();
  return useQuery({
    queryKey: ['indexer', 'availability', url],
    queryFn: async ({ signal }) => {
      if (!url) return false;
      try {
        await indexerQuery<{ __typename: string }>(
          '{ __typename }',
          undefined,
          signal,
        );
        return true;
      } catch {
        return false;
      }
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
    enabled: typeof window !== 'undefined',
  });
}

type UseIndexerQueryArgs<TData> = {
  /** Stable React Query key. Include all variables that should bust cache. */
  key: readonly unknown[];
  query: string;
  variables?: IndexerVariables;
  /** Disable the query (mirrors React Query's `enabled`). */
  enabled?: boolean;
  /** Anything from `UseQueryOptions` you want to override (staleTime etc.). */
  options?: Omit<
    UseQueryOptions<TData, Error>,
    'queryKey' | 'queryFn' | 'enabled'
  >;
};

/**
 * Typed React Query hook wrapping `indexerQuery`. The hook treats
 * "indexer URL unset" as a clean disabled state — `isAvailable` flips
 * false and `data` stays undefined, so call-sites can branch on
 * `isAvailable ? indexerData : rpcFallback`.
 */
export function useIndexerQuery<TData>({
  key,
  query,
  variables,
  enabled = true,
  options,
}: UseIndexerQueryArgs<TData>) {
  const url = resolveIndexerUrl();
  const isAvailable = !!url;

  const result = useQuery<TData, Error>({
    queryKey: ['indexer', ...key],
    queryFn: ({ signal }) => indexerQuery<TData>(query, variables, signal),
    enabled: enabled && isAvailable,
    retry: (count, err) => {
      // Unavailable means the URL is misconfigured server-side — retrying
      // won't help and just burns the proxy quota.
      if (err instanceof IndexerUnavailableError) return false;
      return count < 2;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    ...options,
  });

  return { ...result, isAvailable };
}

/** Hot-invalidate any indexer-derived data; useful after a successful tx. */
export function useInvalidateIndexer() {
  const qc = useQueryClient();
  return (keyPrefix: readonly unknown[] = []) =>
    qc.invalidateQueries({ queryKey: ['indexer', ...keyPrefix] });
}

/**
 * Block-cadence cache invalidator (P0-3).
 *
 * Ponder 0.8.x doesn't expose stable GraphQL subscriptions, so we use the
 * chain's own block heartbeat as the refresh signal: every new block,
 * invalidate every `['indexer', ...]` query. The 30s `staleTime` inside
 * `useIndexerQuery` caps actual re-fetch frequency, so back-to-back blocks
 * during a busy minute don't translate into a re-fetch storm.
 *
 * Mount this exactly once at the AppLayout level. The hook returns nothing;
 * its only effect is the side-channel invalidation.
 */
export function useIndexerBlockInvalidator() {
  const qc = useQueryClient();
  useWatchBlockNumber({
    emitOnBegin: false,
    onBlockNumber: () => {
      // Cheap on the cache layer — invalidateQueries marks stale, the
      // staleTime check inside useQuery decides whether to actually refetch.
      qc.invalidateQueries({ queryKey: ['indexer'] });
    },
  });
}
