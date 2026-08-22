// THE FEED'S ONE JOB, pinned.
//
// A rate is the number people choose a protocol by, and the shape of "we could
// not read it" is the same shape as the shape of "it is zero". Every test below
// is a variant of one assertion: the first never gets to wear the costume of the
// second, at any layer — not on an outage, not on a 200 with a broken body, and
// not on a document that quietly forgot to say where a figure came from.
//
// The provenance half is the one that is easy to lose in a refactor. `source` is
// required on every measurement precisely because a figure with no stated origin
// is indistinguishable from a figure this venue computed itself — which is the
// formula-derived APY that must never reach a surface.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  YieldFeedUnavailableError,
  fetchYieldFeed,
  isYieldFeedConfigured,
  venueReading,
  yieldFeedConfigProblem,
  yieldFeedOrigin,
} from './feed';

const ORIGIN = 'https://yields.example';

function doc(overrides: Record<string, unknown> = {}) {
  return {
    asOf: 1_780_000_000,
    readings: {
      'lido-steth': {
        apyPct: { value: 3.1, source: 'Lido stats API' },
        pegRatio: { value: 0.9994, source: 'Curve stETH/ETH mid' },
        exitLiquidityUsd: { value: 120_000_000, source: 'Curve pool balances' },
      },
    },
    ...overrides,
  };
}

function jsonRes(body: unknown, status = 200) {
  // Typed as `typeof fetch`, not inferred from the zero-argument impl: inferred,
  // `mock.calls[0]` is a zero-length tuple and the URL asserted on below is not
  // reachable from the type system.
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

async function expectUnavailable(p: Promise<unknown>, reason: string) {
  await expect(p).rejects.toBeInstanceOf(YieldFeedUnavailableError);
  await p.catch((e: YieldFeedUnavailableError) => expect(e.reason).toBe(reason));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the absence of VITE_YIELD_FEED_URL is the gate', () => {
  it('is unconfigured when unset or blank, and that is not an error state', () => {
    vi.unstubAllEnvs();
    expect(yieldFeedOrigin()).toBeNull();
    expect(isYieldFeedConfigured()).toBe(false);
    // Unset is the intended resting state for a venue that has not chosen whose
    // numbers to republish — it gets calm copy, not an operator alarm.
    expect(yieldFeedConfigProblem()).toBeNull();
    vi.stubEnv('VITE_YIELD_FEED_URL', '   ');
    expect(yieldFeedOrigin()).toBeNull();
    expect(yieldFeedConfigProblem()).toBeNull();
  });

  it('asks nothing when unconfigured, rather than asking and failing', async () => {
    vi.unstubAllEnvs();
    const fetchImpl = jsonRes(doc());
    await expectUnavailable(fetchYieldFeed({ fetchImpl }), 'not-configured');
    expect(fetchImpl, 'a request went out with no feed configured').not.toHaveBeenCalled();
  });

  it('reads an http(s) origin and drops a trailing slash', () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', `${ORIGIN}/`);
    expect(yieldFeedOrigin()).toBe(ORIGIN);
    vi.stubEnv('VITE_YIELD_FEED_URL', `${ORIGIN}/feed/`);
    expect(yieldFeedOrigin()).toBe(`${ORIGIN}/feed`);
  });

  it('refuses a value that is not an http(s) URL, and tells the operator', () => {
    // A relative value must not become a same-origin request to our own
    // deployment, which answers with the app shell and would be reported as
    // "the feed is down" rather than "this env var has a typo in it".
    for (const bad of ['/yields', 'yields.example', 'ftp://yields.example']) {
      vi.stubEnv('VITE_YIELD_FEED_URL', bad);
      expect(yieldFeedOrigin(), bad).toBeNull();
      expect(yieldFeedConfigProblem(), bad).toMatch(/not a valid http/i);
    }
  });
});

describe('no failure becomes a number', () => {
  it('reports a network error as unreachable', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expectUnavailable(fetchYieldFeed({ fetchImpl }), 'unreachable');
  });

  it('separates rate limiting and 5xx from a refusal', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes({}, 429) }), 'unreachable');
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes({}, 503) }), 'unreachable');
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes({}, 403) }), 'rejected');
  });

  it('reports an unreadable body as malformed rather than as an empty table', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expectUnavailable(fetchYieldFeed({ fetchImpl }), 'malformed');
  });

  it('never resolves to an empty document on any failure path', async () => {
    // The load-bearing property. If ANY branch above returned `{ readings: {} }`
    // instead of throwing, every column would render its "the feed answered but
    // carried nothing" wording — a sentence about the venue, on evidence about
    // the network.
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    for (const status of [429, 500, 403]) {
      await expect(fetchYieldFeed({ fetchImpl: jsonRes({}, status) })).rejects.toBeInstanceOf(
        YieldFeedUnavailableError,
      );
    }
  });
});

describe('a figure that cannot say where it came from does not get shown', () => {
  it('rejects the whole document when any measurement omits its source', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const noSource = doc({
      readings: { 'lido-steth': { apyPct: { value: 3.1 }, pegRatio: null, exitLiquidityUsd: null } },
    });
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes(noSource) }), 'malformed');
  });

  it('rejects an empty source string, which is the same defect wearing a key', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const blank = doc({
      readings: { 'lido-steth': { apyPct: { value: 3.1, source: '   ' }, pegRatio: null, exitLiquidityUsd: null } },
    });
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes(blank) }), 'malformed');
  });

  it('drops the document wholesale rather than salvaging the rows that parse', async () => {
    // Keeping the good rows would silently shorten the comparison, and a table
    // missing its best row is a wrong answer that looks exactly like a right one.
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const mixed = doc({
      readings: {
        'lido-steth': { apyPct: { value: 3.1, source: 'ok' }, pegRatio: null, exitLiquidityUsd: null },
        'rocketpool-reth': { apyPct: { value: 'three', source: 'ok' }, pegRatio: null, exitLiquidityUsd: null },
      },
    });
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes(mixed) }), 'malformed');
  });

  it('rejects a peg of zero, which would render as the most alarming number on the page', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const zeroPeg = doc({
      readings: {
        'lido-steth': { apyPct: null, pegRatio: { value: 0, source: 'oracle' }, exitLiquidityUsd: null },
      },
    });
    await expectUnavailable(fetchYieldFeed({ fetchImpl: jsonRes(zeroPeg) }), 'malformed');
  });
});

describe('null and zero are different answers and both survive the boundary', () => {
  it('carries a null metric through as null, not as a default', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const partial = doc({
      readings: {
        'lido-steth': { apyPct: null, pegRatio: null, exitLiquidityUsd: null },
      },
    });
    const parsed = await fetchYieldFeed({ fetchImpl: jsonRes(partial) });
    const reading = venueReading(parsed, 'lido-steth');
    expect(reading).not.toBeNull();
    expect(reading!.apyPct).toBeNull();
    expect(reading!.pegRatio).toBeNull();
  });

  it('accepts a genuine zero for exit liquidity — "nobody will buy this" is a real reading', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const dry = doc({
      readings: {
        'lido-steth': {
          apyPct: { value: 0, source: 'Lido stats API' },
          pegRatio: null,
          exitLiquidityUsd: { value: 0, source: 'Curve pool balances' },
        },
      },
    });
    const parsed = await fetchYieldFeed({ fetchImpl: jsonRes(dry) });
    const reading = venueReading(parsed, 'lido-steth')!;
    expect(reading.exitLiquidityUsd).toEqual({ value: 0, source: 'Curve pool balances' });
    expect(reading.apyPct).toEqual({ value: 0, source: 'Lido stats API' });
  });

  it('treats a venue the feed never mentioned as no reading at all', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const parsed = await fetchYieldFeed({ fetchImpl: jsonRes(doc()) });
    expect(venueReading(parsed, 'renzo-ezeth')).toBeNull();
    expect(venueReading(null, 'lido-steth')).toBeNull();
  });

  it('reads the happy path when everything is present', async () => {
    vi.stubEnv('VITE_YIELD_FEED_URL', ORIGIN);
    const fetchImpl = jsonRes(doc());
    const parsed = await fetchYieldFeed({ fetchImpl });
    expect(parsed.asOf).toBe(1_780_000_000);
    expect(venueReading(parsed, 'lido-steth')!.pegRatio!.value).toBeCloseTo(0.9994);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${ORIGIN}/yields`);
  });
});
