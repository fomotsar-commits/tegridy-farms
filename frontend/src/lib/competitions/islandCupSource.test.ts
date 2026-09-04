// Reading twelve pools when some of them will not answer.
//
// The failure shape is the whole subject here. One bad pool must not erase the
// eleven that worked, and it must not disappear either: it has to arrive as a
// named coverage entry so the page can say WHICH pool is missing and why.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readIslandCup } from './islandCupSource';
import { __resetPoolTradesCacheForTests } from '../geckoTerminal/poolTrades';
import type { CupPool } from './islandCup';

const T0 = 1_780_000_000;

const alpha: CupPool = {
  id: 'pepe',
  name: 'Pepe',
  symbol: 'PEPE',
  network: 'eth',
  pool: '0xaaaa000000000000000000000000000000000001',
  label: 'PEPE / WETH',
  chain: 'ethereum',
};

const beta: CupPool = {
  id: 'bobo',
  name: 'BOBO',
  symbol: 'BOBO',
  network: 'solana',
  pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
  label: 'BOBO / SOL',
  chain: 'solana',
};

function body(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      attributes: {
        block_timestamp: new Date((T0 + i) * 1000).toISOString(),
        kind: 'buy',
        tx_hash: `0xhash${i}`,
        tx_from_address: '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd',
        from_token_amount: '1',
        to_token_amount: '2',
        volume_in_usd: '12.5',
      },
    })),
  };
}

/** A fetch stub keyed on which pool address appears in the URL. */
function stub(map: Record<string, () => Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, make] of Object.entries(map)) {
      if (url.includes(needle)) return make();
    }
    return new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
}

const okBody = (count = 2) => async () => new Response(JSON.stringify(body(count)), { status: 200 });

beforeEach(() => {
  __resetPoolTradesCacheForTests();
});

describe('readIslandCup', () => {
  it('keeps a failed pool and a successful one side by side, and never rejects', () => {
    // `Promise.all` here would let one throwing pool erase eleven good ones,
    // which on a leaderboard reads as a quiet day.
    const fetchImpl = stub({
      [alpha.pool]: () => Promise.reject(new TypeError('boom')),
      [beta.pool]: okBody(),
    });

    return readIslandCup([alpha, beta], { fetchImpl }).then((read) => {
      expect(read.board.coverage[0]).toMatchObject({ state: 'failed' });
      expect(read.board.coverage[1]).toMatchObject({ state: 'read', trades: 2 });
      expect(read.status).toBe('partial');
      expect(read.board.poolsAnswered).toBe(1);
      expect(read.board.poolsTotal).toBe(2);
    });
  });

  it('reports a 429 as a named failure, not as an empty pool', () => {
    const fetchImpl = stub({
      [alpha.pool]: async () => new Response(JSON.stringify({ status: { error_code: 429 } }), { status: 429 }),
      [beta.pool]: okBody(),
    });

    return readIslandCup([alpha, beta], { fetchImpl }).then((read) => {
      expect(read.board.coverage[0]).toMatchObject({ state: 'failed', reason: 'rate-limited' });
      // The chip carries a sentence a person can act on.
      expect(read.board.coverage[0]).toHaveProperty('detail', expect.stringMatching(/rate-limit/i));
      expect(read.status).toBe('partial');
    });
  });

  it('is unavailable, with no rows, when nothing answers', () => {
    const fetchImpl = stub({
      [alpha.pool]: async () => new Response('nope', { status: 500 }),
      [beta.pool]: async () => new Response('nope', { status: 500 }),
    });

    return readIslandCup([alpha, beta], { fetchImpl }).then((read) => {
      expect(read.status).toBe('unavailable');
      expect(read.board.rows).toEqual([]);
      expect(read.board.coverage.every((c) => c.state === 'failed')).toBe(true);
    });
  });

  it('answers a schema-invalid body as unread rather than as an empty tape', () => {
    const fetchImpl = stub({
      [alpha.pool]: async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
      [beta.pool]: okBody(),
    });

    return readIslandCup([alpha, beta], { fetchImpl }).then((read) => {
      expect(read.board.coverage[0]).toMatchObject({ state: 'failed', reason: 'schema' });
    });
  });

  it('asks the throttled upstream once per pool inside the shared TTL', () => {
    // Two surfaces on one screen, or a reader pressing "Read again", must not
    // multiply into a second burst of twelve requests.
    const fetchImpl = stub({ [alpha.pool]: okBody(), [beta.pool]: okBody() });
    const spy = fetchImpl as unknown as ReturnType<typeof vi.fn>;

    return readIslandCup([alpha, beta], { fetchImpl })
      .then(() => readIslandCup([alpha, beta], { fetchImpl }))
      .then(() => {
        expect(spy).toHaveBeenCalledTimes(2);
      });
  });

  it('does not exceed its concurrency, so twelve pools are not one burst', () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response(JSON.stringify(body(1)), { status: 200 });
    }) as unknown as typeof fetch;

    const many: CupPool[] = Array.from({ length: 9 }, (_, i) => ({
      ...alpha,
      id: `p${i}`,
      pool: `0xaaaa00000000000000000000000000000000000${i}`,
    }));

    return readIslandCup(many, { fetchImpl, concurrency: 3 }).then((read) => {
      expect(peak).toBeLessThanOrEqual(3);
      expect(read.board.coverage).toHaveLength(9);
    });
  });
});
