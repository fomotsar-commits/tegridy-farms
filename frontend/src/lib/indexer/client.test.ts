// THE INDEXER CLIENT'S ONE JOB, pinned.
//
// Indexed history is the data most easily faked by an outage, because the shape
// of "nothing happened" and the shape of "we could not ask" are the same shape:
// an empty list. Every test below is a variant of the same assertion — that the
// second one never gets to wear the costume of the first.
//
// The freshness half is the less obvious one. A REACHABLE indexer mid-backfill
// answers 200 with a short page, and that page is a prefix of the truth, not
// the truth. `_meta { status }` rides along in every document so a caller can
// tell the difference; these tests pin that it is parsed correctly and that an
// absent or unrecognised status reads as "we do not know", never as "ready".

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  IndexerUnavailableError,
  INDEXER_META_SELECTION,
  MAX_PAGE_LIMIT,
  bigIntStringSchema,
  clampPageLimit,
  indexerConfigProblem,
  indexerOrigin,
  indexerQuery,
  isIndexerConfigured,
  parseIndexerMeta,
  pingIndexer,
} from './client';

const ORIGIN = 'https://indexer.example';

const dataSchema = z.object({ swaps: z.object({ items: z.array(z.object({ id: z.string() })) }) });

function readyMeta(block = 25_300_000) {
  return { _meta: { status: { mainnet: { block: { number: block, timestamp: 1_780_000_000 }, ready: true } } } };
}

function jsonRes(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

async function expectUnavailable(p: Promise<unknown>, reason: string) {
  await expect(p).rejects.toBeInstanceOf(IndexerUnavailableError);
  await p.catch((e: IndexerUnavailableError) => expect(e.reason).toBe(reason));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the absence of VITE_INDEXER_URL is the deploy gate', () => {
  it('is unconfigured when unset or blank', () => {
    vi.unstubAllEnvs();
    expect(indexerOrigin()).toBeNull();
    expect(isIndexerConfigured()).toBe(false);
    vi.stubEnv('VITE_INDEXER_URL', '   ');
    expect(indexerOrigin()).toBeNull();
    // Unset is the intended pre-deploy resting state, not a misconfiguration.
    expect(indexerConfigProblem()).toBeNull();
  });

  it('reads an http(s) origin and drops a trailing slash', () => {
    vi.stubEnv('VITE_INDEXER_URL', `${ORIGIN}/`);
    expect(indexerOrigin()).toBe(ORIGIN);
    vi.stubEnv('VITE_INDEXER_URL', `${ORIGIN}/idx/`);
    expect(indexerOrigin()).toBe(`${ORIGIN}/idx`);
  });

  it('refuses a value that is not an http(s) URL, and says so', () => {
    // ⚠ THE HAZARD. A relative or exotic-scheme value must not fall through to
    // a same-origin request against our own Vercel deployment, which answers
    // 404 HTML and would be reported to the operator as "the indexer is down"
    // rather than "this env var has a typo in it".
    for (const bad of ['/graphql', 'indexer.example', 'ftp://indexer.example']) {
      vi.stubEnv('VITE_INDEXER_URL', bad);
      expect(indexerOrigin(), bad).toBeNull();
      expect(indexerConfigProblem(), bad).toMatch(/not a valid http/i);
    }
  });

  it('asks nothing at all when unconfigured', async () => {
    vi.unstubAllEnvs();
    const f = jsonRes(readyMeta());
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch }),
      'not-configured',
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('pings false when unconfigured, without a request', async () => {
    vi.unstubAllEnvs();
    const f = jsonRes(null);
    expect(await pingIndexer({ fetchImpl: f as unknown as typeof fetch })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('a query that succeeds', () => {
  it('POSTs to /graphql and returns validated data plus sync state', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = jsonRes({ data: { swaps: { items: [{ id: 'a' }] }, ...readyMeta() } });

    const out = await indexerQuery({
      query: `{ swaps { items { id } } ${INDEXER_META_SELECTION} }`,
      variables: { limit: 5 },
      schema: dataSchema,
      fetchImpl: f as unknown as typeof fetch,
    });

    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/graphql`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).variables).toEqual({ limit: 5 });

    expect(out.data.swaps.items).toEqual([{ id: 'a' }]);
    expect(out.meta).toEqual({ ready: true, syncedBlock: 25_300_000, syncedAt: 1_780_000_000 });
  });

  it('sends an empty variables object rather than omitting the key', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = jsonRes({ data: { swaps: { items: [] }, ...readyMeta() } });
    await indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch });
    const body = JSON.parse(
      String((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body),
    );
    expect(body.variables).toEqual({});
  });
});

describe('every failure is a failure, never an empty list', () => {
  it('a transport error is unreachable', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = vi.fn(async () => {
      throw new TypeError('network');
    });
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch }),
      'unreachable',
    );
  });

  it('the proxy 429 is unreachable and says retrying helps', async () => {
    // Ponder ships no rate limiting; the mandatory proxy in front of it does
    // (indexer/DEPLOY.md §3), so 429 is an EXPECTED answer under load and must
    // not read as a data problem.
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = jsonRes({}, 429);
    const p = indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch });
    await expectUnavailable(p, 'unreachable');
    await p.catch((e: IndexerUnavailableError) => expect(e.message).toMatch(/rate-limit/i));
  });

  it('5xx is unreachable, 4xx is rejected', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: jsonRes({}, 503) as unknown as typeof fetch }),
      'unreachable',
    );
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: jsonRes({}, 400) as unknown as typeof fetch }),
      'rejected',
    );
  });

  it('a 200 that is not JSON is malformed', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = vi.fn(async () => new Response('<!doctype html>', { status: 200 }));
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch }),
      'malformed',
    );
  });

  it('REFUSES a half-answer that carries both data and errors', async () => {
    // ⚠ THE SUBTLE ONE. GraphQL is allowed to answer 200 with a partially
    // resolved `data` alongside `errors`. Rendering that half puts a truncated
    // list on screen with nothing marking it truncated — a shorter history than
    // the wallet actually has, presented as the history.
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = jsonRes({
      data: { swaps: { items: [{ id: 'a' }] }, ...readyMeta() },
      errors: [{ message: 'resolver blew up on page 2' }],
    });
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch }),
      'rejected',
    );
  });

  it('drops the whole page when any row is off-schema', async () => {
    // Keeping the rows that happen to validate would silently shorten the list
    // — the same fabricated zero wearing a different hat.
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = jsonRes({ data: { swaps: { items: [{ id: 'a' }, { id: 42 }] }, ...readyMeta() } });
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch }),
      'malformed',
    );
  });

  it('a null data field is malformed, not an empty answer', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = jsonRes({ data: null });
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, fetchImpl: f as unknown as typeof fetch }),
      'malformed',
    );
  });
});

describe('abort and timeout discipline', () => {
  it('aborts the request when the caller aborts', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const outer = new AbortController();
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = indexerQuery({
      query: 'q',
      schema: dataSchema,
      signal: outer.signal,
      fetchImpl: f as unknown as typeof fetch,
    });
    outer.abort();
    await expectUnavailable(p, 'unreachable');
  });

  it('gives up on its own timer even when the caller never aborts', async () => {
    // A request with no ceiling outlives the view that asked for it and leaves a
    // spinner with no end state. There is always a ceiling.
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
        }),
    );
    await expectUnavailable(
      indexerQuery({ query: 'q', schema: dataSchema, timeoutMs: 1, fetchImpl: f as unknown as typeof fetch }),
      'unreachable',
    );
  });
});

describe('scalars and bounds', () => {
  it('parses Ponder BigInt strings and rejects anything else', () => {
    expect(bigIntStringSchema.parse('115792089237316195423570985008687907853269984665640564039457584007913129639935')).toBe(
      115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    );
    expect(bigIntStringSchema.safeParse('1.5').success).toBe(false);
    expect(bigIntStringSchema.safeParse('1e18').success).toBe(false);
    expect(bigIntStringSchema.safeParse(12).success).toBe(false);
  });

  it('clamps every page request', () => {
    expect(clampPageLimit(10)).toBe(10);
    expect(clampPageLimit(10_000)).toBe(MAX_PAGE_LIMIT);
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(Number.NaN)).toBe(1);
  });
});

describe('parseIndexerMeta — unknown freshness is never `ready`', () => {
  it('reports ready with the synced block', () => {
    expect(parseIndexerMeta(readyMeta(25_263_400))).toEqual({
      ready: true,
      syncedBlock: 25_263_400,
      syncedAt: 1_780_000_000,
    });
  });

  it('is not ready while any chain is still backfilling', () => {
    const meta = parseIndexerMeta({
      _meta: {
        status: {
          mainnet: { block: { number: 100, timestamp: 10 }, ready: true },
          other: { block: { number: 50, timestamp: 5 }, ready: false },
        },
      },
    });
    expect(meta).toEqual({ ready: false, syncedBlock: 50, syncedAt: 5 });
  });

  it('reports no block at all when one chain has none', () => {
    // Reporting the other chain's height would overstate coverage.
    const meta = parseIndexerMeta({
      _meta: {
        status: {
          mainnet: { block: { number: 100, timestamp: 10 }, ready: true },
          other: { block: null, ready: true },
        },
      },
    });
    expect(meta).toEqual({ ready: true, syncedBlock: null, syncedAt: null });
  });

  it('returns null for absent, empty or unrecognised status', () => {
    expect(parseIndexerMeta({ swaps: { items: [] } })).toBeNull();
    expect(parseIndexerMeta({ _meta: null })).toBeNull();
    expect(parseIndexerMeta({ _meta: { status: null } })).toBeNull();
    expect(parseIndexerMeta({ _meta: { status: {} } })).toBeNull();
    expect(parseIndexerMeta({ _meta: { status: { mainnet: { ready: 'yes' } } } })).toBeNull();
  });
});

describe('pingIndexer is liveness only', () => {
  it('is true on 200 and false on failure', async () => {
    vi.stubEnv('VITE_INDEXER_URL', ORIGIN);
    const ok = vi.fn(async () => new Response('', { status: 200 }));
    expect(await pingIndexer({ fetchImpl: ok as unknown as typeof fetch })).toBe(true);
    expect(String((ok as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toBe(`${ORIGIN}/health`);

    const bad = vi.fn(async () => new Response('', { status: 503 }));
    expect(await pingIndexer({ fetchImpl: bad as unknown as typeof fetch })).toBe(false);

    const boom = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await pingIndexer({ fetchImpl: boom as unknown as typeof fetch })).toBe(false);
  });
});
