import { config } from './config.js';

/**
 * Thin GraphQL client for the Ponder indexer. Same shape as the
 * frontend's `lib/indexer.ts` query helper — kept separate here so the
 * bot doesn't import from `frontend/src` (different runtime, different
 * dep set).
 */

type IndexerError = {
  message: string;
  cause?: unknown;
};

export async function indexerQuery<TData>(
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TData> {
  let resp: Response;
  try {
    resp = await fetch(config.indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (err) {
    throw new IndexerNetworkError(
      err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'network error',
      err,
    );
  }
  if (!resp.ok) {
    throw new IndexerNetworkError(`HTTP ${resp.status}`, undefined);
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    throw new IndexerNetworkError('non-JSON response', err);
  }
  if (typeof json !== 'object' || json === null) {
    throw new IndexerNetworkError('malformed payload', undefined);
  }
  const envelope = json as {
    data?: TData;
    errors?: Array<{ message: string }>;
  };
  if (envelope.errors?.length) {
    throw new IndexerGraphqlError(envelope.errors[0]!.message ?? 'indexer error', envelope.errors);
  }
  if (envelope.data === undefined) {
    throw new IndexerNetworkError('no data', undefined);
  }
  return envelope.data;
}

export class IndexerNetworkError extends Error implements IndexerError {
  constructor(message: string, public cause?: unknown) {
    super(`indexer network: ${message}`);
    this.name = 'IndexerNetworkError';
  }
}

export class IndexerGraphqlError extends Error implements IndexerError {
  constructor(message: string, public graphqlErrors: Array<{ message: string }>) {
    super(`indexer graphql: ${message}`);
    this.name = 'IndexerGraphqlError';
  }
}
