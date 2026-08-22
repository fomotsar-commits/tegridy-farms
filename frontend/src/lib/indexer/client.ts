// Network boundary for the Ponder indexer (F1), browser side.
//
// The indexer is a separate long-running service, NOT a Vercel function — see
// indexer/DEPLOY.md and frontend/api/SERVERLESS_BUDGET.md ("do not add an
// api/indexer.js"). This client talks to its public reverse proxy directly.
//
// FAIL-CLOSED, and the reason is specific to indexed data. Every failure path
// throws IndexerUnavailableError; none of them returns an empty page. An empty
// page and an unreachable indexer look identical once they reach a component —
// both render as "no swaps", "no history", "0" — and only one of them is a fact
// about the chain. "We could not ask" and "it did not happen" must never
// collapse into each other.
//
// The subtler half of the same problem: a REACHABLE indexer that has not
// finished its historical backfill answers 200 with a short or empty page. That
// is not an outage and not an answer either, so every query here asks for
// `_meta { status }` in the same round trip and callers branch on
// `meta.ready` before believing a zero. See INDEXER_META_SELECTION.

import { z } from 'zod';

/**
 * The indexer's public origin, or null when the venue has no indexer to ask.
 *
 * Read through a function rather than captured as a module constant so a test
 * can stub it and so nothing snapshots the value at module-init — same rule as
 * heatGateConfig.ts.
 *
 * The absence of this variable IS the deploy gate. There is no separate flag:
 * until the operator finishes indexer/DEPLOY.md and sets VITE_INDEXER_URL,
 * every consumer reports `unavailable`, which is the correct resting state.
 */
export function indexerOrigin(): string | null {
  const raw = (import.meta.env.VITE_INDEXER_URL as string | undefined)?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // A relative or exotic-scheme value must not become a same-origin request to
  // our own Vercel deployment, which would 404 as HTML and read as an outage
  // of the indexer rather than as the misconfiguration it is.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Set-but-unusable, described for whoever has to fix it.
 *
 * Distinct from "unset" on purpose: unset is the intended pre-deploy state and
 * deserves calm copy, whereas a typo'd URL is a live misconfiguration that
 * would otherwise be reported to the operator as "the indexer is down".
 */
export function indexerConfigProblem(): string | null {
  const raw = (import.meta.env.VITE_INDEXER_URL as string | undefined)?.trim();
  if (!raw) return null;
  return indexerOrigin() === null
    ? 'VITE_INDEXER_URL is set but is not a valid http(s) URL, so no request was attempted.'
    : null;
}

export function isIndexerConfigured(): boolean {
  return indexerOrigin() !== null;
}

export type IndexerUnavailableReason =
  /** No VITE_INDEXER_URL, or one that does not parse. Nothing was asked. */
  | 'not-configured'
  /** Asked, no usable answer: network error, timeout, 5xx, or the proxy's 429. */
  | 'unreachable'
  /** Answered, and the answer was an error — GraphQL `errors`, or a 4xx. */
  | 'rejected'
  /** Answered 200 with a body we cannot trust: unparseable, or off-schema. */
  | 'malformed';

export class IndexerUnavailableError extends Error {
  readonly reason: IndexerUnavailableReason;

  constructor(reason: IndexerUnavailableReason, message: string) {
    super(message);
    this.name = 'IndexerUnavailableError';
    this.reason = reason;
  }
}

/**
 * Hard ceiling per request.
 *
 * Higher than the heat oracle's 6s (heatClient.ts) because this is a paginated
 * Postgres read behind a proxy rather than a single cached lookup, and lower
 * than anything that would let a stuck request outlive the view that asked for
 * it. Both halves matter: no request here may hang forever, and a slow indexer
 * must surface as unavailable rather than as a spinner with no end.
 */
export const INDEXER_TIMEOUT_MS = 8000;

/** Liveness ping only — it must not wait as long as a real query. */
export const INDEXER_HEALTH_TIMEOUT_MS = 4000;

/**
 * Largest page any caller may ask for.
 *
 * The lesson is already written in this repo at useDeployerReputation.ts: an
 * unbounded page does not fail cleanly, it fails as a response too large to
 * read, deterministically, forever, and looks like an outage. Ponder's own
 * server cap is 1000; ours is far lower because no surface here shows more.
 */
export const MAX_PAGE_LIMIT = 100;

export function clampPageLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), MAX_PAGE_LIMIT);
}

// ─── Scalars ─────────────────────────────────────────────────────────────────

/**
 * Ponder serialises its BigInt scalar with `String(value)` (verified against
 * ponder 0.8's GraphQLBigInt), so every uint256 arrives as a decimal string.
 * Rejecting anything else keeps a silently-changed upstream from landing as
 * NaN in a balance.
 */
export const bigIntStringSchema = z
  .string()
  .regex(/^-?\d+$/, 'must be a decimal integer string')
  .transform((s) => BigInt(s));

/** `t.hex()` address columns. Ponder returns lowercase 0x-prefixed. */
export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address');

/** `t.hex()` transaction hashes. */
export const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 32-byte hex hash');

/** Every page type Ponder generates carries this. */
export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

// ─── Sync metadata ───────────────────────────────────────────────────────────

/**
 * The selection every query in this codebase must include.
 *
 * Not optional and not a nicety: without it a caller cannot tell a synced
 * indexer's honest empty page from a backfilling indexer's incomplete one, and
 * the second one rendered as the first is exactly the fabricated zero this
 * client exists to prevent. `useIndexedQuery` refuses a document that omits it.
 */
export const INDEXER_META_SELECTION = '_meta { status }';

const metaNetworkSchema = z.object({
  block: z
    .object({ number: z.number(), timestamp: z.number() })
    .nullable()
    .optional(),
  ready: z.boolean(),
});

const metaEnvelopeSchema = z.object({
  _meta: z
    .object({ status: z.record(z.string(), metaNetworkSchema).nullable() })
    .nullable(),
});

export interface IndexerMeta {
  /**
   * True only when EVERY indexed chain has finished its historical backfill.
   * While false, an empty or short page means nothing — the rows may simply not
   * be indexed yet.
   */
  ready: boolean;
  /** Lowest block reached across chains, or null when no chain reports one. */
  syncedBlock: number | null;
  /** Unix seconds of that block, or null. Lets a surface show its own lag. */
  syncedAt: number | null;
}

/**
 * Read sync state out of a GraphQL `data` object.
 *
 * Returns null when the document did not ask for `_meta`, when Ponder has not
 * written a status row yet, or when the shape is unrecognised — all three are
 * "we do not know how fresh this is", which callers must treat as not-ready
 * rather than assuming the best.
 */
export function parseIndexerMeta(data: unknown): IndexerMeta | null {
  const parsed = metaEnvelopeSchema.safeParse(data);
  if (!parsed.success) return null;
  const status = parsed.data._meta?.status;
  if (!status) return null;

  const networks = Object.values(status);
  if (networks.length === 0) return null;

  let syncedBlock: number | null = null;
  let syncedAt: number | null = null;
  for (const net of networks) {
    const block = net.block ?? null;
    if (block === null) {
      // One chain with no block at all makes the aggregate block meaningless;
      // reporting the other chain's height would overstate coverage.
      syncedBlock = null;
      syncedAt = null;
      break;
    }
    syncedBlock = syncedBlock === null ? block.number : Math.min(syncedBlock, block.number);
    syncedAt = syncedAt === null ? block.timestamp : Math.min(syncedAt, block.timestamp);
  }

  return {
    ready: networks.every((n) => n.ready === true),
    syncedBlock,
    syncedAt,
  };
}

// ─── Transport ───────────────────────────────────────────────────────────────

const graphqlErrorSchema = z.object({ message: z.string().optional() });
const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(graphqlErrorSchema).optional(),
});

export interface IndexerQueryOptions<T> {
  /** Full GraphQL document. Must contain INDEXER_META_SELECTION. */
  query: string;
  variables?: Record<string, unknown>;
  /** Validates the `data` object. Unknown keys (like `_meta`) are stripped. */
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injection seam for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface IndexerResponse<T> {
  data: T;
  /** Null when the document omitted `_meta` or the indexer reported no status. */
  meta: IndexerMeta | null;
}

/**
 * POST one GraphQL document and validate the answer, or throw.
 *
 * There is no partial-success path. GraphQL can answer 200 with both `data` and
 * `errors` — a half-resolved response — and rendering that half would put a
 * truncated list on screen with nothing marking it truncated. A response
 * carrying any error is an unavailable indexer, full stop.
 */
export async function indexerQuery<T>(opts: IndexerQueryOptions<T>): Promise<IndexerResponse<T>> {
  const origin = indexerOrigin();
  if (origin === null) {
    throw new IndexerUnavailableError(
      'not-configured',
      indexerConfigProblem() ??
        'No indexer is configured for this deployment, so no indexed history can be shown.',
    );
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? INDEXER_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await doFetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
      signal: ac.signal,
    });
  } catch {
    throw new IndexerUnavailableError(
      'unreachable',
      'The indexer did not answer in time. This is a service problem, not a statement about your history.',
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  // The proxy in front of Ponder enforces the rate limiting Ponder has none of
  // (indexer/DEPLOY.md §3), so 429 is an expected answer under load and gets
  // its own wording — retrying is useful, and nothing is wrong with the data.
  if (res.status === 429) {
    throw new IndexerUnavailableError(
      'unreachable',
      'The indexer is rate-limiting right now. Give it a moment and try again.',
    );
  }
  if (res.status >= 500) {
    throw new IndexerUnavailableError(
      'unreachable',
      'The indexer is not answering right now. Nothing below reflects the chain.',
    );
  }
  if (!res.ok) {
    throw new IndexerUnavailableError(
      'rejected',
      'The indexer refused this query, so no indexed history could be read.',
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new IndexerUnavailableError('malformed', 'The indexer returned something unreadable.');
  }

  const envelope = graphqlEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new IndexerUnavailableError('malformed', 'The indexer returned an unrecognised response.');
  }
  if (envelope.data.errors && envelope.data.errors.length > 0) {
    throw new IndexerUnavailableError(
      'rejected',
      'The indexer reported an error for this query, so nothing is shown rather than part of an answer.',
    );
  }
  if (envelope.data.data === undefined || envelope.data.data === null) {
    throw new IndexerUnavailableError('malformed', 'The indexer answered without any data.');
  }

  const parsed = opts.schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    // Off-schema rows are dropped WHOLESALE rather than filtered. Keeping the
    // rows that happen to validate would silently shorten a list, which is the
    // fabricated-zero failure wearing a different hat.
    throw new IndexerUnavailableError(
      'malformed',
      'The indexer returned data in an unexpected shape, so none of it is shown.',
    );
  }

  return { data: parsed.data, meta: parseIndexerMeta(envelope.data.data) };
}

/**
 * Liveness ping against the proxy's `/health`.
 *
 * DELIBERATELY NOT A FRESHNESS CHECK. Ponder's `/health` answers 200 with an
 * empty body whenever the process is up — it checks neither the database nor
 * the sync (verified against ponder 0.8's server). Use it to tell "there is a
 * service there" from "there is nothing there"; use `meta.ready` from a real
 * query for anything about the data. Treating a green /health as freshness is
 * precisely how a backfilling indexer would get rendered as an empty chain.
 */
export async function pingIndexer(
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const origin = indexerOrigin();
  if (origin === null) return false;

  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INDEXER_HEALTH_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  try {
    const res = await doFetch(`${origin}/health`, { method: 'GET', signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
