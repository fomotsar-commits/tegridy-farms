// ONE ASSERTION, WRITTEN OUT MANY WAYS: an empty tape must never be able to
// mean "we could not read the tape".
//
// A trade list is the data most easily faked by an outage, because "nobody
// traded" and "the price API is down" have the same shape once they reach a
// component — an array of length zero. Every unread branch below is pinned to a
// DIFFERENT reason, because they are different sentences to a user: a 429 means
// try again in a moment, a 500 means the venue's feed is refusing, a cancel
// means nothing at all and must not raise a banner.
//
// The second theme is the buy/sell leg, inherited from usePoolTrades.test.ts.
// It is pinned again here because the rule moved into this module, and it is the
// kind of mistake that renders a plausible number: the quote leg printed as a
// token size is 0.61 where the truth is 116,200.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  __resetPoolTradesCacheForTests,
  num,
  poolTradesCacheKey,
  poolTradesUrl,
  readPoolTrades,
  readPoolTradesCached,
} from './poolTrades';

const MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SOL = 'So11111111111111111111111111111111111111112';

function trade(kind: 'buy' | 'sell', tokenAmount: string, solAmount: string, extra: Record<string, unknown> = {}) {
  return {
    attributes: {
      block_timestamp: '2026-08-28T07:42:18Z',
      kind,
      tx_hash: `tx-${kind}-${tokenAmount}`,
      tx_from_address: 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5',
      from_token_address: kind === 'buy' ? SOL : MINT,
      from_token_amount: kind === 'buy' ? solAmount : tokenAmount,
      to_token_address: kind === 'buy' ? MINT : SOL,
      to_token_amount: kind === 'buy' ? tokenAmount : solAmount,
      volume_in_usd: '65.19',
      block_number: 24_100_100,
      ...extra,
    },
  };
}

function jsonRes(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  __resetPoolTradesCacheForTests();
});

describe('poolTradesUrl', () => {
  it('addresses one pool on one network, encoding both segments', () => {
    const url = poolTradesUrl('solana', MINT);
    expect(url).toBe(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${MINT}/trades`);
  });

  it('cannot be steered into another endpoint by its arguments', () => {
    // An address is never supposed to contain a slash — which is exactly why an
    // unencoded template is a hole: the day one does, it lands as path
    // structure and silently calls a different endpoint.
    const url = poolTradesUrl('solana', '../../simple/networks/eth/token_price/x');
    expect(url).not.toContain('/simple/');
    expect(url.endsWith('/trades')).toBe(true);
  });
});

describe('readPoolTrades — the failure branches are all different failures', () => {
  it('names a 429 as rate-limiting, with retry-worthy wording', async () => {
    const fetchImpl = jsonRes({ status: { error_code: 429 } }, 429);
    const read = await readPoolTrades('solana', 'pool', { fetchImpl });
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    // Folded into 'http' this would tell a user the feed refused their pool,
    // which is wrong: nothing is wrong with the pool and retrying works.
    expect(read.reason).toBe('rate-limited');
    expect(read.detail).toMatch(/try again/i);
  });

  it('names any other refusal as http, and says which', async () => {
    const read = await readPoolTrades('solana', 'pool', { fetchImpl: jsonRes({}, 503) });
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    expect(read.reason).toBe('http');
    expect(read.detail).toContain('503');
  });

  it('names an unreachable feed as network, not as an empty tape', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const read = await readPoolTrades('solana', 'pool', { fetchImpl });
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    expect(read.reason).toBe('network');
  });

  it('names OUR OWN cancel as aborted, so a navigation raises no banner', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const read = await readPoolTrades('solana', 'pool', { fetchImpl, signal: ac.signal });
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    // Reported as 'network' this would put "the feed is down" on screen every
    // time a user leaves a bungalow page.
    expect(read.reason).toBe('aborted');
  });

  it('rejects an off-schema body WHOLESALE rather than returning the rows it liked', async () => {
    // `kind: 'mint'` has no label on the tape. Filtering it out would render a
    // one-row tape with nothing marking it as truncated.
    const fetchImpl = jsonRes({
      data: [trade('buy', '10', '0.1'), { attributes: { block_timestamp: 'x', kind: 'mint', tx_hash: 't' } }],
    });
    const read = await readPoolTrades('solana', 'pool', { fetchImpl });
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    expect(read.reason).toBe('schema');
  });

  it('asks nothing at all when no pool is named', async () => {
    const fetchImpl = jsonRes({ data: [] });
    const read = await readPoolTrades('solana', '', { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(read.status).toBe('unread');
    if (read.status !== 'unread') return;
    expect(read.reason).toBe('not-attempted');
  });

  it('NEVER rejects, whatever the transport does', async () => {
    // An escaping rejection becomes an unhandled rejection, which Playwright
    // reports as a WebKit pageerror — a GeckoTerminal outage would red the
    // whole e2e suite.
    const throwers = [
      vi.fn(() => { throw new Error('sync throw'); }),
      vi.fn(async () => { throw new Error('async throw'); }),
      vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) as unknown as Response),
    ];
    for (const fetchImpl of throwers) {
      await expect(readPoolTrades('solana', 'pool', { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .resolves.toMatchObject({ status: 'unread' });
    }
  });
});

describe('readPoolTrades — a real answer', () => {
  it('separates a genuinely quiet pool from an unread one', async () => {
    const read = await readPoolTrades('solana', 'pool', { fetchImpl: jsonRes({ data: [] }) });
    // THE POINT OF THE WHOLE MODULE: zero fills is a READ, and it is the only
    // way a caller is ever allowed to see an empty array.
    expect(read.status).toBe('read');
    if (read.status !== 'read') return;
    expect(read.trades).toEqual([]);
  });

  it('takes the RECEIVED leg on a buy and the GIVEN leg on a sell', async () => {
    const fetchImpl = jsonRes({ data: [trade('buy', '522.26', '0.0003'), trade('sell', '116200.35', '0.61')] });
    const read = await readPoolTrades('solana', 'pool', { fetchImpl });
    expect(read.status).toBe('read');
    if (read.status !== 'read') return;
    const [buy, sell] = read.trades;
    expect(buy?.tokenAmount, 'a buy must report the token received, not the SOL paid').toBeCloseTo(522.26);
    expect(sell?.tokenAmount, 'a sell must report the token given, not the SOL received').toBeCloseTo(116200.35);
  });

  it('carries both legs and the block through, so a caller knows WHICH pair traded', async () => {
    const fetchImpl = jsonRes({ data: [trade('buy', '522.26', '0.0003')] });
    const read = await readPoolTrades('solana', 'pool', { fetchImpl });
    if (read.status !== 'read') throw new Error('expected a read');
    const t = read.trades[0]!;
    expect(t.fromTokenAddress).toBe(SOL);
    expect(t.toTokenAddress).toBe(MINT);
    // The raw amounts stay STRINGS: a token with 18 decimals loses digits the
    // moment it becomes a float, and the tape is not the place to lose them.
    expect(t.fromTokenAmount).toBe('0.0003');
    expect(t.blockNumber).toBe(24_100_100);
  });

  it('leaves an absent figure absent instead of calling it zero', async () => {
    const fetchImpl = jsonRes({ data: [trade('buy', '1', '1', { volume_in_usd: null })] });
    const read = await readPoolTrades('solana', 'pool', { fetchImpl });
    if (read.status !== 'read') throw new Error('expected a read');
    // `?? 0` here would print a $0 trade — a claim the upstream never made.
    expect(read.trades[0]?.usd).toBeNull();
  });

  it('stamps the read with the injected wall clock', async () => {
    const read = await readPoolTrades('solana', 'pool', {
      fetchImpl: jsonRes({ data: [] }),
      now: () => 1_788_000_000_000,
    });
    if (read.status !== 'read') throw new Error('expected a read');
    expect(read.fetchedAt).toBe(1_788_000_000_000);
  });
});

describe('num', () => {
  it('keeps null null and never manufactures a zero', () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('not a number')).toBeNull();
    expect(num('0')).toBe(0);
    expect(num(0)).toBe(0);
    expect(num('12.5')).toBe(12.5);
  });
});

describe('the cache', () => {
  it('keys on network AND pool', () => {
    // A pool-only key is a cross-network cache the moment two chains are live,
    // and it fails silently: one token's tape under another's ticker.
    expect(poolTradesCacheKey('eth', '0xabc')).not.toBe(poolTradesCacheKey('base', '0xabc'));
    expect(poolTradesCacheKey('eth', '0xabc')).toBe('eth:0xabc');
  });

  it('serves four surfaces from one request', async () => {
    const fetchImpl = jsonRes({ data: [trade('buy', '1', '1')] });
    await readPoolTradesCached('solana', 'pool', { fetchImpl });
    await readPoolTradesCached('solana', 'pool', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not serve one pool from another pool cache entry', async () => {
    const fetchImpl = jsonRes({ data: [] });
    await readPoolTradesCached('solana', 'poolA', { fetchImpl });
    await readPoolTradesCached('solana', 'poolB', { fetchImpl });
    await readPoolTradesCached('base', 'poolA', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('NEVER caches a failure', async () => {
    // Cached, one 429 becomes a minute of manufactured silence — and the retry
    // the user presses does nothing while still looking like it did.
    const failing = jsonRes({}, 429);
    const first = await readPoolTradesCached('solana', 'pool', { fetchImpl: failing });
    expect(first.status).toBe('unread');

    const ok = jsonRes({ data: [trade('buy', '1', '1')] });
    const second = await readPoolTradesCached('solana', 'pool', { fetchImpl: ok });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('read');
  });

  it('re-reads once the entry is older than the TTL', async () => {
    const fetchImpl = jsonRes({ data: [] });
    await readPoolTradesCached('solana', 'pool', { fetchImpl, ttlMs: 0 });
    await readPoolTradesCached('solana', 'pool', { fetchImpl, ttlMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is reset between tests, so one test cannot answer another', async () => {
    const fetchImpl = jsonRes({ data: [] });
    await readPoolTradesCached('solana', 'pool', { fetchImpl });
    __resetPoolTradesCacheForTests();
    await readPoolTradesCached('solana', 'pool', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
