// One walk per visit, a gated refresh, and a board that is null whenever the
// alternative would be a claim.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { __resetIslandTapeCacheForTests, useIslandTape } from './useIslandTape';
import { MIN_TAPE_REFRESH_SECONDS, type IslandPool } from '../lib/copytrade/tape';
import { WETH_ADDRESS } from '../lib/constants';

const TX = `0x${'ab'.repeat(32)}`;
const SENDER = '0x1111111111111111111111111111111111111111';

function pool(id: string, address: string): IslandPool {
  return {
    bungalowId: id,
    symbol: id.toUpperCase(),
    network: 'eth',
    family: 'evm',
    pool: address,
    label: `${id.toUpperCase()} / WETH`,
    baseToken: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
    quoteToken: WETH_ADDRESS.toLowerCase(),
  };
}

const POOLS: IslandPool[] = [pool('a', '0xaaa'), pool('b', '0xbbb'), pool('c', '0xccc')];

const OK_BODY = {
  data: [
    {
      attributes: {
        block_timestamp: '2026-09-01T12:00:00Z',
        kind: 'buy',
        tx_hash: TX,
        tx_from_address: SENDER,
        from_token_address: WETH_ADDRESS.toLowerCase(),
        from_token_amount: '0.5',
        to_token_address: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
        to_token_amount: '100',
        volume_in_usd: '1200',
      },
    },
  ],
};

function fakeFetch(per: (url: string) => { status: number; body: unknown }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const { status, body } = per(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

const noSleep = async () => {};

beforeEach(() => {
  __resetIslandTapeCacheForTests();
  localStorage.clear();
});

describe('useIslandTape', () => {
  it('reads each pool exactly once per mount and does not re-read on re-render', async () => {
    const f = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const { result, rerender } = renderHook(() =>
      useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => 1_000_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender();
    rerender();
    expect(f.mock.calls).toHaveLength(POOLS.length);
    expect(result.current.board!.rows).toHaveLength(1);
    expect(result.current.detail).toBeNull();
  });

  it('goes PARTIAL when a pool could not be read, and names it', async () => {
    const f = fakeFetch((url) => (url.includes('0xbbb') ? { status: 500, body: {} } : { status: 200, body: OK_BODY }));
    const { result } = renderHook(() =>
      useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => 1_000_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe('partial'));
    // Partial still draws the board it HAS — with the pool it does not named
    // beside it, so a short read is never mistaken for a quiet island.
    expect(result.current.board).not.toBeNull();
    expect(result.current.detail).toContain('B / WETH');
    expect(result.current.detail).toContain('2 of 3 island pools answered');
  });

  it('goes UNAVAILABLE with a NULL board when nothing could be read', async () => {
    const f = fakeFetch(() => ({ status: 429, body: { status: { error_code: 429 } } }));
    const { result } = renderHook(() =>
      useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => 1_000_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    // The mutation this pins: rendering `{ rows: [] }` here. An empty board is a
    // statement about every wallet at once, produced by a rate limit.
    expect(result.current.board).toBeNull();
    expect(result.current.detail).toContain('rate-limit');
  });

  it('refuses a refresh inside the gate and says when it will be armed', async () => {
    const f = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    let clock = 1_000_000;
    const { result } = renderHook(() =>
      useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => clock }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(f.mock.calls).toHaveLength(3);

    act(() => result.current.refresh());
    expect(f.mock.calls).toHaveLength(3);
    expect(result.current.refreshAvailableAt).toBe(1_000_000 + MIN_TAPE_REFRESH_SECONDS * 1000);

    clock += MIN_TAPE_REFRESH_SECONDS * 1000 + 1;
    act(() => result.current.refresh());
    await waitFor(() => expect(f.mock.calls).toHaveLength(6));
  });

  it('serves a second mount from memory rather than re-asking a throttled feed', async () => {
    const f = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const first = renderHook(() => useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => 1_000_000 }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();

    const second = renderHook(() =>
      useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => 1_000_010 }),
    );
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(f.mock.calls).toHaveLength(3);
  });

  it('writes nothing to localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const f = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const { result } = renderHook(() =>
      useIslandTape({ pools: POOLS, fetchImpl: f, sleep: noSleep, now: () => 1_000_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // The tape is a sixty-second read. Persisting it would need a decoder, a
    // version and an eviction rule for a value that is worthless next visit.
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('excludes the viewer from the board', async () => {
    const f = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const exclude = [SENDER.toUpperCase()];
    const { result } = renderHook(() =>
      useIslandTape({ pools: POOLS, exclude, fetchImpl: f, sleep: noSleep, now: () => 1_000_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.board!.rows).toEqual([]);
    expect(result.current.board!.fillsRead).toBe(3);
  });
});
