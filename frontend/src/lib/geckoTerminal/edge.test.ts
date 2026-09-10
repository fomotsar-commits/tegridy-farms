// The invariant this file exists for:
//
//   NO GeckoTerminal read is issued from the browser to api.geckoterminal.com.
//   Every one goes to our own origin, where `api/_lib/gecko-read.js` answers it
//   from the CDN.
//
// It is pinned as a PROPERTY of each URL the app actually builds, not as a
// string match on the source, because the property is what the outage was made
// of: 46 of 64 prod routes logged a failed GeckoTerminal read, and the cause was
// the keyless per-IP rate limit rather than anything about CORS. A read that
// still leaves the page for the third-party host is still on that budget no
// matter how the source is spelled.
//
// The second half is the one a single-sided test would miss: a same-origin URL
// the PROXY refuses is not a fix, it is a 400 on a read that used to work. So
// every URL built here is fed through the server's own `isAllowedPath` — the
// exact function the deployed handler gates on — rather than through a copy of
// its rules.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isAllowedPath } from '../../../api/_lib/gecko-read.js';
import { GECKO_EDGE_RESOURCE, geckoEdgeUrl } from './edge';
import { geckoPoolsUrl, geckoPoolsMultiUrl } from './pools';
import { poolTradesUrl } from './poolTrades';
import { ohlcvUrlFor, GECKO_TIMEFRAME_IDS } from '../chart/ohlcv';
import { ohlcvUrl, TOWELI_MARKET, TF_CONFIG, type Timeframe } from '../chart/market';
import { fetchTokenOhlcv } from '../solanaChart';
import { PROTOCOL_ACTIVITY_ENDPOINT } from '../../hooks/useProtocolActivity';
import { TOWELI_PRICE_ENDPOINT } from '../../hooks/useToweliPrice';

// Real ids, so a fixture cannot drift into a shape the server would refuse.
const EVM_POOL = '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f';
const SOL_POOL = '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX';

/** The upstream path a same-origin edge URL is asking for, or null. */
function pathOf(url: string): string | null {
  const m = /[?&]path=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Both halves of the invariant for one built URL: it never leaves our origin,
 * and the deployed handler will actually serve it.
 */
function expectServedByOurEdge(url: string): void {
  expect(url.startsWith('/'), `must be same-origin, got: ${url}`).toBe(true);
  expect(url).not.toMatch(/api\.geckoterminal\.com/);
  expect(url.startsWith(GECKO_EDGE_RESOURCE)).toBe(true);
  const path = pathOf(url);
  expect(path, `no path param in: ${url}`).not.toBeNull();
  expect(isAllowedPath(path as string), `server would refuse: ${path}`).toBe(true);
}

describe('geckoEdgeUrl', () => {
  it('keeps the path separators literal so the network stays recoverable', () => {
    // pools.ts#networkFromUrl matches /networks/([^/?#]+) against the request
    // URL — percent-encoding the slashes here would silently return null and a
    // response would be parsed under no network's address rules.
    const url = geckoEdgeUrl('/networks/eth/new_pools');
    expect(url).toContain('path=/networks/eth/new_pools');
    expect(/\/networks\/([^/?#]+)/.exec(url)?.[1]).toBe('eth');
  });

  it('appends only the parameters it was given, encoded', () => {
    const url = geckoEdgeUrl('/networks/eth/pools/x/ohlcv/hour', { aggregate: 4, limit: 90, currency: 'usd' });
    expect(url).toContain('&aggregate=4');
    expect(url).toContain('&limit=90');
    expect(url).toContain('&currency=usd');
    expect(url).not.toContain('page=');
  });
});

describe('every GeckoTerminal URL the browser builds is served by our own edge', () => {
  it('pools list views', () => {
    for (const network of ['eth', 'base', 'solana'] as const) {
      for (const view of ['new', 'trending'] as const) {
        expectServedByOurEdge(geckoPoolsUrl(network, view));
      }
    }
  });

  it('pools/multi', () => {
    expectServedByOurEdge(geckoPoolsMultiUrl('eth', [EVM_POOL]));
    expectServedByOurEdge(geckoPoolsMultiUrl('solana', [SOL_POOL]));
  });

  it('pool trades', () => {
    expectServedByOurEdge(poolTradesUrl('eth', EVM_POOL));
    expectServedByOurEdge(poolTradesUrl('solana', SOL_POOL));
  });

  it('chart candles (lib/chart/ohlcv.ts)', () => {
    for (const tf of GECKO_TIMEFRAME_IDS) {
      expectServedByOurEdge(ohlcvUrlFor({ network: 'eth', pool: EVM_POOL }, tf));
    }
  });

  it('chart candles (lib/chart/market.ts)', () => {
    for (const tf of Object.keys(TF_CONFIG) as Timeframe[]) {
      expectServedByOurEdge(ohlcvUrl(TOWELI_MARKET, tf));
      expectServedByOurEdge(ohlcvUrl(TOWELI_MARKET, tf, 'token'));
    }
  });

  it('the protocol pulse trades feed', () => {
    expectServedByOurEdge(PROTOCOL_ACTIVITY_ENDPOINT);
  });

  it('the site-wide display price', () => {
    expectServedByOurEdge(TOWELI_PRICE_ENDPOINT);
  });

  it('the Solana chart, on both legs of its read', async () => {
    // This one has no exported URL builder: it resolves a mint's top pool and
    // then asks that pool for candles, so the URLs only exist mid-flight. Both
    // legs are captured, because a fix that moved one and left the other is the
    // shape of half-done this whole file is here to catch.
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      const body = seen.length === 1
        ? { data: [{ id: `solana_${SOL_POOL}` }] }
        : { data: { attributes: { ohlcv_list: [] } } };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }));

    await fetchTokenOhlcv('So11111111111111111111111111111111111111112', '1H');

    expect(seen).toHaveLength(2);
    for (const url of seen) expectServedByOurEdge(url);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
