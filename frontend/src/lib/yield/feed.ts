// Network boundary for external yield readings, browser side.
//
// WHAT THIS IS NOT. It is not the Ponder indexer and must never be pointed at it:
// nothing in src/lib/indexer indexes Lido, Aave or an AVS set, so a second client
// here is not a second path to the same data — it is the only path to different
// data. The gating SHAPE is copied from indexer/client.ts deliberately, because
// the failure being guarded is identical.
//
// FAIL-CLOSED, and the reason is specific to yield. A rate is the number people
// choose a protocol by, and an unreachable feed produces the most persuasive lie
// available: 0.00%. Nothing here returns a zero, a default or a partial document.
// Every failure path throws, and every metric a feed could not read arrives as
// `null` — which callers must render as unavailable, never as a figure.
//
// THE PEG IS THE POINT. A 1.00 assumption is how a holder discovers a depeg at
// the worst possible moment, so a peg is a READING like any other: absent means
// unknown, and unknown is printed as unknown.
//
// EVERY NUMBER CARRIES ITS SOURCE. A measurement without a named source is
// rejected by the schema rather than accepted and shown, because a figure whose
// provenance nobody can state is indistinguishable from one this venue made up —
// and a formula-derived APY is exactly what must never reach a surface here.

import { z } from 'zod';

/**
 * The feed's public origin, or null when this deployment has none.
 *
 * Read through a function rather than captured at module-init so a redeployed
 * dial cannot be out-voted by a stale closure — the rule heatGateConfig.ts and
 * indexer/client.ts both follow.
 *
 * The absence of this variable IS the gate. There is no separate flag and no
 * default endpoint: an unset value means every reading reports unavailable, which
 * is the correct resting state for a venue that has not chosen whose numbers to
 * republish.
 */
export function yieldFeedOrigin(): string | null {
  const raw = (import.meta.env.VITE_YIELD_FEED_URL as string | undefined)?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // A relative or exotic-scheme value must not degrade into a same-origin request
  // against our own deployment, which answers 404 with the app shell and would be
  // reported to an operator as "the feed is down" rather than "this env var has a
  // typo in it".
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Set-but-unusable, described for whoever has to fix it. Distinct from unset. */
export function yieldFeedConfigProblem(): string | null {
  const raw = (import.meta.env.VITE_YIELD_FEED_URL as string | undefined)?.trim();
  if (!raw) return null;
  return yieldFeedOrigin() === null
    ? 'VITE_YIELD_FEED_URL is set but is not a valid http(s) URL, so no request was attempted.'
    : null;
}

export function isYieldFeedConfigured(): boolean {
  return yieldFeedOrigin() !== null;
}

export type YieldFeedUnavailableReason =
  /** No VITE_YIELD_FEED_URL, or one that does not parse. Nothing was asked. */
  | 'not-configured'
  /** Asked, no usable answer: network error, timeout, 5xx, or a 429. */
  | 'unreachable'
  /** Answered, and the answer was a refusal. */
  | 'rejected'
  /** Answered 200 with a body that cannot be trusted: unparseable, or off-schema. */
  | 'malformed';

export class YieldFeedUnavailableError extends Error {
  readonly reason: YieldFeedUnavailableReason;

  constructor(reason: YieldFeedUnavailableReason, message: string) {
    super(message);
    this.name = 'YieldFeedUnavailableError';
    this.reason = reason;
  }
}

/**
 * Hard ceiling per request.
 *
 * Matched to INDEXER_TIMEOUT_MS rather than chosen independently: both are a
 * single JSON read behind somebody else's proxy, and a slow feed must surface as
 * unavailable rather than as a spinner that never resolves.
 */
export const YIELD_FEED_TIMEOUT_MS = 8000;

/**
 * How old a reading may be before it stops being current.
 *
 * A rate an hour stale is still a real measurement, so it is shown WITH its age
 * rather than suppressed — suppressing it would trade a disclosed staleness for
 * an undisclosed blank. What it is not allowed to do is be presented as live, or
 * to count toward a "this is the best rate" claim.
 */
export const YIELD_READING_MAX_AGE_S = 3600;

/**
 * One number and where it came from.
 *
 * `source` is required, not optional, and the schema is what enforces it. This is
 * the mechanical form of "yields are read, never estimated": a document that
 * cannot name where a figure came from does not get to put that figure on screen.
 */
const measurementSchema = z.object({
  value: z.number().finite(),
  source: z.string().trim().min(1, 'every measurement must name where it was read'),
});

export type YieldMeasurement = z.infer<typeof measurementSchema>;

/**
 * A peg ratio is a positive multiple of the reference asset, never zero.
 *
 * Zero here would not be a depeg reading, it would be a parse failure wearing
 * one — and a "peg: 0.00" on a comparison table is the single most alarming
 * number this surface could invent.
 */
const pegMeasurementSchema = measurementSchema.refine((m) => m.value > 0, {
  message: 'a peg ratio must be greater than zero',
});

/**
 * Exit liquidity is allowed to be a genuine zero, and that is not the same defect.
 *
 * "Nobody will buy this right now" is a real, important reading; the rule this
 * file exists to enforce is that an UNREAD figure never renders as zero, not that
 * zero can never be read. `null` and `0` mean different things here and both are
 * carried through to the surface intact.
 */
const liquidityMeasurementSchema = measurementSchema.refine((m) => m.value >= 0, {
  message: 'exit liquidity cannot be negative',
});

/**
 * One venue's readings.
 *
 * Every metric is nullable and null is meaningful: it is the feed stating that it
 * could not read this one. A metric key that is absent entirely is treated the
 * same way — see `venueReading` — so a feed that drops a field silently degrades
 * to "unknown" rather than to a default.
 */
const readingSchema = z.object({
  apyPct: measurementSchema.nullable(),
  pegRatio: pegMeasurementSchema.nullable(),
  exitLiquidityUsd: liquidityMeasurementSchema.nullable(),
});

export type YieldReading = z.infer<typeof readingSchema>;

const documentSchema = z.object({
  /** Unix seconds. When the feed took these readings, not when we asked for them. */
  asOf: z.number().int().positive(),
  readings: z.record(z.string(), readingSchema),
});

export type YieldFeedDocument = z.infer<typeof documentSchema>;

export interface YieldFeedOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injection seam for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch and validate the whole document, or throw.
 *
 * There is no partial-success path and no per-row salvage. Keeping the rows that
 * happen to validate would silently shorten a comparison table, and a comparison
 * table missing its best row is a wrong answer that looks exactly like a right
 * one. A document that does not parse is an unavailable feed, full stop.
 */
export async function fetchYieldFeed(opts: YieldFeedOptions = {}): Promise<YieldFeedDocument> {
  const origin = yieldFeedOrigin();
  if (origin === null) {
    throw new YieldFeedUnavailableError(
      'not-configured',
      yieldFeedConfigProblem() ??
        'This deployment publishes no yield feed, so no rate, peg or exit-liquidity figure can be read.',
    );
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? YIELD_FEED_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await doFetch(`${origin}/yields`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
  } catch {
    throw new YieldFeedUnavailableError(
      'unreachable',
      'The yield feed did not answer in time. Nothing below is a statement about anyone’s rate.',
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (res.status === 429) {
    throw new YieldFeedUnavailableError(
      'unreachable',
      'The yield feed is rate-limiting right now. Give it a moment and try again.',
    );
  }
  if (res.status >= 500) {
    throw new YieldFeedUnavailableError(
      'unreachable',
      'The yield feed is not answering right now, so no rate could be read.',
    );
  }
  if (!res.ok) {
    throw new YieldFeedUnavailableError(
      'rejected',
      'The yield feed refused this request, so no rate could be read.',
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new YieldFeedUnavailableError('malformed', 'The yield feed returned something unreadable.');
  }

  const parsed = documentSchema.safeParse(body);
  if (!parsed.success) {
    throw new YieldFeedUnavailableError(
      'malformed',
      'The yield feed returned figures in an unexpected shape, or figures that do not say where they came from, so none of them are shown.',
    );
  }
  return parsed.data;
}

/**
 * One venue's row out of a document, or null when the feed carried nothing for it.
 *
 * A venue the feed has never heard of and a venue the feed could not read are
 * both "no figures", and neither is allowed to become a figure — the caller turns
 * this null into an explicit unavailable state rather than into a blank cell.
 */
export function venueReading(doc: YieldFeedDocument | null, venueId: string): YieldReading | null {
  if (doc === null) return null;
  return doc.readings[venueId] ?? null;
}
