// The feed hook's five states, and the one that matters most.
//
// `unavailable` must be reachable WITHOUT a network call and must carry a
// non-null reason, because that is the state this build ships in: no
// VITE_INDEXER_URL means nothing was asked, and a page that spun forever or
// silently showed zero pairs would be describing the chain instead of the
// deployment.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTerminalFeed } from './useTerminalFeed';

const ORIGIN = 'https://indexer.example';
const PAIR_A = '0x1111111111111111111111111111111111111111';
const WETH = '0x4444444444444444444444444444444444444444';
const TOKEN_X = '0x3333333333333333333333333333333333333333';

function body(opts: { ready: boolean; eventsNext?: boolean }) {
  return {
    data: {
      indexedPairs: {
        items: [{ id: PAIR_A, token0: WETH, token1: TOKEN_X, allowed: true }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      pairEvents: {
        items: [{ id: 'e1', type: 'swap', pair: PAIR_A, timestamp: '1780000000' }],
        pageInfo: { hasNextPage: opts.eventsNext ?? false, endCursor: null },
      },
      _meta: {
        status: { mainnet: { block: { number: 25_300_000, timestamp: 1_780_000_000 }, ready: opts.ready } },
      },
    },
  };
}

function jsonRes(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('with no indexer configured', () => {
  it('lands in unavailable with a reason, and never fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useTerminalFeed());

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.feed).toBeNull();
    expect(result.current.detail).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('with an indexer that answers', () => {
  beforeEach(() => vi.stubEnv('VITE_INDEXER_URL', ORIGIN));

  it('assembles the feed when the indexer reports a finished backfill', async () => {
    vi.stubGlobal('fetch', jsonRes(body({ ready: true })));

    const { result } = renderHook(() => useTerminalFeed());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.feed?.rows).toHaveLength(1);
    expect(result.current.feed?.rows[0].pair).toBe(PAIR_A);
    expect(result.current.detail).toBeNull();
  });

  it('reports backfilling — with the rows, and with the warning — mid-sync', async () => {
    vi.stubGlobal('fetch', jsonRes(body({ ready: false })));

    const { result } = renderHook(() => useTerminalFeed());

    await waitFor(() => expect(result.current.status).toBe('backfilling'));
    // The rows that DID come back are real, so they are shown; what is not
    // claimed is that they are all of them.
    expect(result.current.feed?.rows).toHaveLength(1);
    expect(result.current.detail).toMatch(/still replaying history/i);
  });

  it('a 5xx is unavailable with NO feed — never an empty row list', async () => {
    vi.stubGlobal('fetch', jsonRes({}, 503));

    const { result } = renderHook(() => useTerminalFeed());

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.feed).toBeNull();
    expect(result.current.detail).toMatch(/not answering/i);
  });

  it('a GraphQL error is unavailable, not a partial feed', async () => {
    vi.stubGlobal('fetch', jsonRes({ data: null, errors: [{ message: 'no such column' }] }));

    const { result } = renderHook(() => useTerminalFeed());

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.feed).toBeNull();
  });

  it('carries the truncated event window through to the feed', async () => {
    vi.stubGlobal('fetch', jsonRes(body({ ready: true, eventsNext: true })));

    const { result } = renderHook(() => useTerminalFeed());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.feed?.eventWindowTruncated).toBe(true);
  });
});
