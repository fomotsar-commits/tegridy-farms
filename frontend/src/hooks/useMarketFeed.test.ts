import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook, waitFor, act } from '@testing-library/react';
import { __resetMarketFeedCacheForTests, useMarketFeed } from './useMarketFeed';

// THE HOOK'S ONE JOB IS TO KEEP FOUR OUTCOMES APART, and three of them look
// identical from a component that only reads `rows`:
//
//   429            -> unreachable / rate-limited   (the LIMIT refused us)
//   off-schema     -> unreachable / malformed      (we will not render it)
//   rejected fetch -> unreachable / network        (we never got there)
//   {"data": []}   -> READY with zero rows         (the upstream's own answer)
//
// The last one is a market observation. The first three are not, and a hook that
// caught any of them into `{status:'ready', rows:[]}` would put a claim about an
// entire chain on screen. That is exactly what this app's same-origin proxy
// does, which is why this reads browser-direct — pinned below.

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/lib/geckoTerminal/fixtures', name), 'utf8'),
  );
}

const ETH_NEW = fixture('eth_new_pools.json');
const RATE_LIMITED = fixture('rate_limited_429.json');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetMarketFeedCacheForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the four outcomes never collapse into each other', () => {
  it('a 429 is rate-limited, and carries no rows field at all', async () => {
    // The real 429 body has NO `data` key, so a hook that parsed before checking
    // the status would land on "malformed" — or, worse, on zero pools.
    fetchMock.mockResolvedValue(jsonResponse(RATE_LIMITED, 429));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('unreachable'));
    expect(result.current.state).toMatchObject({ status: 'unreachable', reason: 'rate-limited' });
    expect(result.current.state).not.toHaveProperty('rows');
  });

  it('a 200 with an off-schema body is malformed, not empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pools: ['not', 'our', 'shape'] }));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('unreachable'));
    expect(result.current.state).toMatchObject({ reason: 'malformed' });
  });

  it('a rejected fetch is a network failure, not an empty market', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('unreachable'));
    expect(result.current.state).toMatchObject({ reason: 'network' });
  });

  it('a non-429 HTTP error names itself as http, with the code in the detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('unreachable'));
    expect(result.current.state).toMatchObject({ reason: 'http' });
    expect(
      result.current.state.status === 'unreachable' && result.current.state.detail,
    ).toContain('503');
  });

  it('{"data": []} is READY with zero rows — the upstream answered, and that is different', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({ status: 'ready', dropped: 0 });
    expect(result.current.state.status === 'ready' && result.current.state.rows).toEqual([]);
  });

  it('parses a real capture into rows', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ETH_NEW));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.rows.length).toBeGreaterThan(0);
    // rows + dropped is always the whole upstream list, so a surface can say
    // "18 of 20" rather than presenting 18 as the whole truth.
    expect(state.rows.length + state.dropped).toBe(3);
  });

  it('an unreadable entry is DROPPED AND COUNTED, never silently filtered', async () => {
    // Real capture shape, one entry's identity broken — a 32-byte Uniswap v4
    // pool id is the live version of this, and holding it to the address rule
    // would otherwise shrink the list with nothing on screen to say so.
    const body = structuredClone(ETH_NEW) as { data: Array<Record<string, unknown>> };
    const broken = body.data[0];
    if (!broken) throw new Error('fixture is empty');
    broken.id = 'eth_0xnot-an-address';
    (broken.attributes as Record<string, unknown>).address = '0xnot-an-address';

    fetchMock.mockResolvedValue(jsonResponse(body));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.dropped).toBe(1);
    expect(state.rows.length + state.dropped).toBe(body.data.length);
  });
});

describe('browser-direct, never the same-origin proxy', () => {
  it('asks GeckoTerminal for ETH new pools by URL', async () => {
    // The proxy at /api/aggregator?resource=launch-radar turns a 429 into an
    // HTTP 200 empty list and CDN-caches it. If this assertion ever flips to a
    // same-origin path, every test above becomes unreachable in production.
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('https://api.geckoterminal.com/api/v2/networks/eth/new_pools');
    expect(url).not.toContain('/api/aggregator');
    expect(url).not.toContain('launch-radar');
  });

  it('asks for Base trending on the base network', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    renderHook(() => useMarketFeed({ view: 'list', network: 'base', list: 'trending' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.geckoterminal.com/api/v2/networks/base/trending_pools',
    );
  });

  it('a multi request joins validated addresses into the path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const a = '0x1111111111111111111111111111111111111111';
    renderHook(() =>
      useMarketFeed({ view: 'multi', network: 'eth', pools: [a, 'not-an-address'] }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`https://api.geckoterminal.com/api/v2/networks/eth/pools/multi/${a}`);
    expect(url).not.toContain('not-an-address');
  });

  it('asks NOTHING when a multi view has no pools — that is a sentence, not a failed read', async () => {
    const { result } = renderHook(() => useMarketFeed({ view: 'multi', network: 'eth', pools: [] }));
    await waitFor(() => expect(result.current.state.status).toBe('idle'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks nothing for a null request (the indexer view)', async () => {
    const { result } = renderHook(() => useMarketFeed(null));
    await waitFor(() => expect(result.current.state.status).toBe('idle'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the cache prevents requests and never causes them', () => {
  it('two mounts of the same (network, view) read once', async () => {
    // Four rapid keyless reads from one address is enough to be refused, and
    // clicking through tabs and back is the normal way to use this page.
    fetchMock.mockResolvedValue(jsonResponse(ETH_NEW));
    const first = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'));

    const second = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));
    await waitFor(() => expect(second.result.current.state.status).toBe('ready'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a different view is a different question and reads again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ETH_NEW));
    const a = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));
    await waitFor(() => expect(a.result.current.state.status).toBe('ready'));
    const b = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'trending' }));
    await waitFor(() => expect(b.result.current.state.status).toBe('ready'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('two watchlists of the same length on the same network are different questions', async () => {
    // The mutation this catches: a cache key of `multi:${network}` alone, which
    // would serve one starred list another's rows.
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0x2222222222222222222222222222222222222222';
    const one = renderHook(() => useMarketFeed({ view: 'multi', network: 'eth', pools: [a] }));
    await waitFor(() => expect(one.result.current.state.status).toBe('ready'));
    const two = renderHook(() => useMarketFeed({ view: 'multi', network: 'eth', pools: [b] }));
    await waitFor(() => expect(two.result.current.state.status).toBe('ready'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reload() bypasses the cache — a button that says Re-read must re-read', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ETH_NEW));
    const { result } = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('the read time is stamped once, not read from a clock', () => {
  it('readAt comes from the response and does not move as time passes', async () => {
    // A Date.now()-on-render implementation passes every other test in this file
    // and turns a static table into one whose ages drift away from the prices
    // beside them. `readAt` is the anchor the Age column is computed against.
    fetchMock.mockResolvedValue(jsonResponse(ETH_NEW));
    const { result, rerender } = renderHook(() =>
      useMarketFeed({ view: 'list', network: 'eth', list: 'new' }),
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    const first = result.current.state.status === 'ready' ? result.current.state.readAt : -1;

    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    rerender();

    expect(result.current.state.status === 'ready' && result.current.state.readAt).toBe(first);
  });

  it('a cached re-mount reports the ORIGINAL read time, not the moment it was served', async () => {
    // Re-stamping here is the ticking clock this page refuses: the rows would be
    // a minute old while the banner said they were read this instant.
    fetchMock.mockResolvedValue(jsonResponse(ETH_NEW));
    const first = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'));
    const readAt = first.result.current.state.status === 'ready' ? first.result.current.state.readAt : -1;

    vi.setSystemTime(new Date(Date.now() + 30_000));
    const second = renderHook(() => useMarketFeed({ view: 'list', network: 'eth', list: 'new' }));
    await waitFor(() => expect(second.result.current.state.status).toBe('ready'));

    expect(second.result.current.state.status === 'ready' && second.result.current.state.readAt).toBe(
      readAt,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
