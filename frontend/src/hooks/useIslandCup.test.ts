// The cup hook: one read per mount, a reload that respects the shared TTL, and
// no interval anywhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useIslandCup } from './useIslandCup';
import { __resetPoolTradesCacheForTests } from '../lib/geckoTerminal/poolTrades';
import type { CupPool } from '../lib/competitions/islandCup';

const T0 = 1_780_000_000;

const pools: CupPool[] = [
  {
    id: 'pepe',
    name: 'Pepe',
    symbol: 'PEPE',
    network: 'eth',
    pool: '0xaaaa000000000000000000000000000000000001',
    label: 'PEPE / WETH',
    chain: 'ethereum',
  },
  {
    id: 'bobo',
    name: 'BOBO',
    symbol: 'BOBO',
    network: 'solana',
    pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
    label: 'BOBO / SOL',
    chain: 'solana',
  },
];

function body() {
  return {
    data: [
      {
        attributes: {
          block_timestamp: new Date(T0 * 1000).toISOString(),
          kind: 'buy',
          tx_hash: '0xhash',
          tx_from_address: '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd',
          from_token_amount: '1',
          to_token_amount: '2',
          volume_in_usd: '12.5',
        },
      },
    ],
  };
}

let fetchImpl: typeof fetch;
let calls: () => number;

beforeEach(() => {
  __resetPoolTradesCacheForTests();
  const spy = vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 }));
  fetchImpl = spy as unknown as typeof fetch;
  calls = () => spy.mock.calls.length;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useIslandCup', () => {
  it('reads every pool once and reports a complete board', async () => {
    const { result } = renderHook(() => useIslandCup({ pools, fetchImpl }));

    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(result.current.board).not.toBeNull();
    // Two rows, not one, from the same upstream sender string: the EVM pool
    // lowercases it and the Solana pool keeps it byte-identical, so they are
    // deliberately different identities. Collapsing them would hand one chain's
    // trader the other's volume.
    expect(result.current.board!.rows).toHaveLength(2);
    expect(result.current.board!.legsRead).toBe(2);
    expect(result.current.poolsTotal).toBe(2);
    expect(calls()).toBe(pools.length);
  });

  it('serves a reload from the shared cache rather than re-burdening the feed', async () => {
    // The TTL exists to respect a throttled upstream, not to imply a stream. Two
    // presses of "Read again" inside it must issue no new request at all.
    const { result } = renderHook(() => useIslandCup({ pools, fetchImpl }));
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(calls()).toBe(2);

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.status).toBe('complete'));

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.status).toBe('complete'));

    expect(calls()).toBe(2);
  });

  it('does not mount an interval — nothing here polls', async () => {
    // Settled by flushing the task queue rather than by waitFor, which schedules
    // an interval of its own and would mask exactly what this test is watching.
    const interval = vi.spyOn(globalThis, 'setInterval');
    const { result } = renderHook(() => useIslandCup({ pools, fetchImpl }));
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(result.current.status).toBe('complete');
    expect(interval).not.toHaveBeenCalled();
  });

  it('leaves the board null when nothing could be read, but keeps the coverage', async () => {
    // The table must not render over an outage; the chips must still say which
    // pool failed, because a missing pool and a quiet pool look identical.
    const dead = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useIslandCup({ pools, fetchImpl: dead }));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.board).toBeNull();
    expect(result.current.coverage).toHaveLength(2);
    expect(result.current.coverage.every((c) => c.state === 'failed')).toBe(true);
  });

  it('marks the board partial when one pool refuses', async () => {
    const mixed = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes(pools[0]!.pool)
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify(body()), { status: 200 }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useIslandCup({ pools, fetchImpl: mixed }));
    await waitFor(() => expect(result.current.status).toBe('partial'));
    expect(result.current.board).not.toBeNull();
    expect(result.current.board!.poolsAnswered).toBe(1);
  });

  it('stays idle when it is given no pools', async () => {
    const { result } = renderHook(() => useIslandCup({ pools: [], fetchImpl }));
    await waitFor(() => expect(result.current.poolsTotal).toBe(0));
    expect(result.current.status).toBe('idle');
    expect(result.current.board).toBeNull();
    expect(calls()).toBe(0);
  });
});
