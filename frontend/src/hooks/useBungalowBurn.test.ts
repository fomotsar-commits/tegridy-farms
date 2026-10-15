// The burn hook's contract: it asks the TOKEN's chain, and one leg that did not land
// makes the whole burn unread. A partial reading must never print a smaller burn.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BUNGALOWS, type Bungalow } from '../lib/bungalows';
import { EVM_BURN_ADDRESS, type BurnFact } from '../lib/bungalowBurn';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; chainId: number; functionName: string; args?: readonly unknown[] };
type ReadConfig = { contracts: Query[]; query?: Record<string, unknown> };

// Answers are keyed by chain, token, function and args. A hook that asked the wrong chain,
// or swapped two legs, finds nothing under its key and reads as a failure.
const wagmi = vi.hoisted(() => ({
  answers: new Map<string, ReadCell>(),
  configs: [] as ReadConfig[],
  mode: 'answered' as 'answered' | 'pending' | 'errored' | 'errored-with-old-data',
  refetch: vi.fn(async () => undefined),
}));
const keyOf = (q: Query) =>
  `${q.chainId}:${q.address.toLowerCase()}:${q.functionName}:${(q.args ?? []).map(String).join(',')}`;

vi.mock('wagmi', () => ({
  useReadContracts: (config: ReadConfig) => {
    wagmi.configs.push(config);
    const idle = { data: undefined, isError: false, isFetching: false, refetch: wagmi.refetch };
    if (!config.query?.enabled) return idle;
    if (wagmi.mode === 'pending') return { ...idle, isFetching: true };
    if (wagmi.mode === 'errored') return { ...idle, isError: true };
    return {
      ...idle,
      // TanStack keeps the last good data when a later read throws as a whole.
      isError: wagmi.mode === 'errored-with-old-data',
      data: config.contracts.map(
        (q) => wagmi.answers.get(keyOf(q)) ?? { status: 'failure', error: new Error(`unmocked ${keyOf(q)}`) },
      ),
    };
  },
}));

// Every EVM token in the registry counts its own balance today. A token that does not is the
// default for a new one, so its path is tested through this override of the record lookup.
const record = vi.hoisted(() => ({ override: null as null | ((id: string) => unknown) }));
vi.mock('../lib/bungalowBurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bungalowBurn')>();
  return {
    ...actual,
    burnFactFor: (b: Parameters<typeof actual.burnFactFor>[0]) =>
      (record.override?.(b.id) as BurnFact | null | undefined) ?? actual.burnFactFor(b),
  };
});

const { useBungalowBurn, SOLANA_READ_TIMEOUT_MS } = await import('./useBungalowBurn');

const room = (id: string): Bungalow => BUNGALOWS.find((b) => b.id === id)!;
const ok = (result: unknown): ReadCell => ({ status: 'success', result });
const fail = (): ReadCell => ({ status: 'failure', error: new Error('rpc down') });
const E18 = 10n ** 18n;

type Leg = 'totalSupply' | 'decimals' | 'balanceOf' | 'ownBalance';
function seed(b: Bungalow, chainId: number, over: Partial<Record<Leg, ReadCell>> = {}) {
  const at = (fn: string, args = '') => `${chainId}:${b.address!.toLowerCase()}:${fn}:${args}`;
  wagmi.answers.set(at('totalSupply'), over.totalSupply ?? ok(100_000_000_000n * E18));
  wagmi.answers.set(at('decimals'), over.decimals ?? ok(18));
  wagmi.answers.set(at('balanceOf', EVM_BURN_ADDRESS), over.balanceOf ?? ok(1_315_291_862n * E18));
  // The token contract's balance of its own token: the same function, told apart by its argument.
  wagmi.answers.set(at('balanceOf', b.address!), over.ownBalance ?? ok(0n));
}

const supplyResponse = (amount: string, decimals = 6) => ({
  ok: true,
  status: 200,
  json: async () => [{ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { amount, decimals } } }],
}) as unknown as Response;

function serveSupply(amount: string, decimals = 6) {
  const spy = vi.fn(async (..._args: unknown[]) => supplyResponse(amount, decimals));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  record.override = null;
  wagmi.answers.clear();
  wagmi.configs.length = 0;
  wagmi.mode = 'answered';
});
afterEach(() => vi.unstubAllGlobals());

describe('useBungalowBurn on an EVM token', () => {
  it('reads a Base token on Base: supply, decimals and the burn address in one batch', () => {
    seed(room('drb'), 8453);
    const { result } = renderHook(() => useBungalowBurn(room('drb')));
    expect(result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 1_315_291_862n * E18 } });
    expect(result.current.isReading).toBe(false);
  });

  it('reads an Ethereum token on Ethereum', () => {
    seed(room('pepe'), 1, { totalSupply: ok(420_690_000_000_000n * E18), balanceOf: ok(6_917_544_537_127n * E18) });
    const { result } = renderHook(() => useBungalowBurn(room('pepe')));
    expect(result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 6_917_544_537_127n * E18 } });
  });

  it('does not read a Base token from Ethereum', () => {
    seed(room('drb'), 1);
    const { result } = renderHook(() => useBungalowBurn(room('drb')));
    expect(result.current.burn.status).toBe('unread');
  });

  it.each(['totalSupply', 'decimals', 'balanceOf', 'ownBalance'] as const)(
    'is unread when %s alone did not land, though the other two did',
    (leg) => {
      seed(room('mfer'), 8453, { [leg]: fail() });
      const { result } = renderHook(() => useBungalowBurn(room('mfer')));
      expect(result.current.burn).toEqual({ status: 'unread' });
      // Not reading: Refresh is the only way back from an outage, and it is disabled while reading.
      expect(result.current.isReading).toBe(false);
    },
  );

  it('MFER: adds what is stuck in the token\'s own contract, read from the token\'s own address', () => {
    seed(room('mfer'), 8453, {
      totalSupply: ok(1_000_000_000n * E18), balanceOf: ok(934_220n * E18), ownBalance: ok(364_950n * E18),
    });
    const { result } = renderHook(() => useBungalowBurn(room('mfer')));
    expect(result.current.burn).toMatchObject({
      status: 'read',
      tally: { atBurnAddressRaw: 934_220n * E18, inOwnContractRaw: 364_950n * E18, burntRaw: 1_299_170n * E18 },
    });
  });

  it('MFER: is unread when the own-balance leg alone did not land, never a smaller burn', () => {
    seed(room('mfer'), 8453, { totalSupply: ok(1_000_000_000n * E18), balanceOf: ok(934_220n * E18), ownBalance: fail() });
    const { result } = renderHook(() => useBungalowBurn(room('mfer')));
    expect(result.current.burn).toEqual({ status: 'unread' });
    expect(result.current.isReading).toBe(false);
  });

  it('a token whose record does not count its own balance ignores that leg, landed or not', () => {
    record.override = (id) => (id === 'jbm'
      ? { minted: '100000000000', decimals: 18, countsSupplyDrop: false, mintTx: '0x00' } satisfies BurnFact
      : null);
    seed(room('jbm'), 8453, { ownBalance: ok(5_000_000_000n * E18) });
    const counted = renderHook(() => useBungalowBurn(room('jbm')));
    expect(counted.result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 1_315_291_862n * E18 } });

    seed(room('jbm'), 8453, { ownBalance: fail() });
    const failed = renderHook(() => useBungalowBurn(room('jbm')));
    expect(failed.result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 1_315_291_862n * E18 } });
  });

  it('a null bungalow is idle and reads nothing', () => {
    const { result } = renderHook(() => useBungalowBurn(null));
    expect(result.current.burn).toEqual({ status: 'idle' });
    expect(wagmi.configs.every((c) => c.query?.enabled === false)).toBe(true);
  });

  it('hands the chain\'s own decimals to the tally: a token that answers 6 where the record says 18 gets no figure', () => {
    seed(room('mfer'), 8453, { decimals: ok(6), totalSupply: ok(1_000_000_000n * E18), balanceOf: ok(0n) });
    const { result } = renderHook(() => useBungalowBurn(room('mfer')));
    expect(result.current.burn).toEqual({ status: 'mismatch', reason: 'decimals' });
  });

  it('is loading before the batch answers, and unread if the whole query errors', () => {
    wagmi.mode = 'pending';
    const pending = renderHook(() => useBungalowBurn(room('qr')));
    expect(pending.result.current.burn).toEqual({ status: 'loading' });
    expect(pending.result.current.isReading).toBe(true);

    wagmi.mode = 'errored';
    const errored = renderHook(() => useBungalowBurn(room('qr')));
    expect(errored.result.current.burn).toEqual({ status: 'unread' });
    expect(errored.result.current.isReading).toBe(false);
  });

  it('is unread when a re-read failed as a whole, even though an older answer is still held', () => {
    seed(room('drb'), 8453);
    wagmi.mode = 'errored-with-old-data';
    const { result } = renderHook(() => useBungalowBurn(room('drb')));
    expect(result.current.burn).toEqual({ status: 'unread' });
  });

  it('reports a mismatch, not a figure, when the chain contradicts the minted record', () => {
    seed(room('bnkr'), 8453, { totalSupply: ok(100_000_000_001n * E18) });
    const { result } = renderHook(() => useBungalowBurn(room('bnkr')));
    expect(result.current.burn).toEqual({ status: 'mismatch', reason: 'supply-above-minted' });
  });

  it('reads on every mount: no timer, no refetch on focus or reconnect, and Refresh asks again', () => {
    seed(room('jbm'), 8453);
    const { result } = renderHook(() => useBungalowBurn(room('jbm')));
    const query = wagmi.configs.at(-1)!.query!;
    expect(query.enabled).toBe(true);
    // 0, not the app's 30 s default: a second mount of the same token must read, not reuse.
    expect(query.staleTime).toBe(0);
    // 'always': the default pauses a read while the device is offline, so Refresh did nothing
    // and the old figure stayed on screen. It must run and fail into the outage line.
    expect(query.networkMode).toBe('always');
    expect(query.refetchOnWindowFocus).toBe(false);
    expect(query.refetchOnReconnect).toBe(false);
    expect(query.refetchInterval).toBeUndefined();

    expect(wagmi.refetch).not.toHaveBeenCalled();
    act(() => result.current.refresh());
    expect(wagmi.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('useBungalowBurn on a Solana token', () => {
  it('reads the supply through the proxy and leaves the EVM batch switched off', async () => {
    const spy = serveSupply('989301008790751');
    const { result } = renderHook(() => useBungalowBurn(room('bayla')));
    expect(result.current.burn).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.burn.status).toBe('read'));
    expect(result.current.burn).toMatchObject({ tally: { burntRaw: 10_698_991_209249n } });
    expect(result.current.isReading).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(wagmi.configs.every((c) => c.query?.enabled === false)).toBe(true);
  });

  it('is unread when the supply could not be read, never "everything burnt"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response));
    const { result } = renderHook(() => useBungalowBurn(room('soy')));
    await waitFor(() => expect(result.current.burn.status).not.toBe('loading'));
    expect(result.current.burn).toEqual({ status: 'unread' });
    await waitFor(() => expect(result.current.isReading).toBe(false));
  });

  it('says it is reading during a re-read, and keeps the last figure up meanwhile', async () => {
    const spy = serveSupply('999992834177471');
    const { result } = renderHook(() => useBungalowBurn(room('bobo')));
    await waitFor(() => expect(result.current.burn.status).toBe('read'));
    await waitFor(() => expect(result.current.isReading).toBe(false));

    spy.mockImplementation(() => new Promise<Response>(() => {})); // the re-read never lands
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.isReading).toBe(true));
    expect(result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 7_165_822529n } });
  });

  it('hands the mint\'s own decimals to the tally: 9 where the record says 6 gets no figure', async () => {
    serveSupply('989301008790751', 9);
    const { result } = renderHook(() => useBungalowBurn(room('bayla')));
    await waitFor(() => expect(result.current.burn.status).not.toBe('loading'));
    expect(result.current.burn).toEqual({ status: 'mismatch', reason: 'decimals' });
  });

  it('handed another bungalow, it starts over instead of showing the last one\'s burn', async () => {
    // BAYLA and BOBO share decimals and minted, so BAYLA's reading would tally cleanly as BOBO's.
    const spy = serveSupply('989301008790751');
    const { result, rerender } = renderHook(({ b }) => useBungalowBurn(b), { initialProps: { b: room('bayla') } });
    await waitFor(() => expect(result.current.burn.status).toBe('read'));

    spy.mockImplementation(() => new Promise<Response>(() => {})); // BOBO's read never lands
    rerender({ b: room('bobo') });
    expect(result.current.burn).toEqual({ status: 'loading' });
  });

  it('drops an answer that lands after the bungalow changed', async () => {
    let releaseBayla!: (r: Response) => void;
    const spy = vi.fn((..._args: unknown[]) => new Promise<Response>((resolve) => { releaseBayla = resolve; }));
    vi.stubGlobal('fetch', spy);
    const { result, rerender } = renderHook(({ b }) => useBungalowBurn(b), { initialProps: { b: room('bayla') } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    spy.mockImplementation(async () => supplyResponse('999992834177471'));
    rerender({ b: room('bobo') });
    await waitFor(() => expect(result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 7_165_822529n } }));

    await act(async () => { releaseBayla(supplyResponse('989301008790751')); });
    expect(result.current.burn).toMatchObject({ status: 'read', tally: { burntRaw: 7_165_822529n } });
  });

  it('gives up a read that never answers: unread, with Refresh back, not "Reading…" for good', async () => {
    vi.useFakeTimers();
    try {
      // A fetch that only ever ends by being aborted, as a stalled connection does.
      const spy = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      vi.stubGlobal('fetch', spy);
      const { result } = renderHook(() => useBungalowBurn(room('brainlet')));
      await act(async () => { await vi.advanceTimersByTimeAsync(SOLANA_READ_TIMEOUT_MS - 1000); });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.current.burn).toEqual({ status: 'loading' });

      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(result.current.burn).toEqual({ status: 'unread' });
      expect(result.current.isReading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts its read when the card unmounts', async () => {
    const spy = vi.fn((..._args: unknown[]) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', spy);
    const { unmount } = renderHook(() => useBungalowBurn(room('rizz')));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const { signal } = spy.mock.calls[0]![1] as RequestInit;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('Refresh reads again and shows the new figure', async () => {
    const spy = serveSupply('999992834177471');
    const { result } = renderHook(() => useBungalowBurn(room('bobo')));
    await waitFor(() => expect(result.current.burn.status).toBe('read'));
    expect(result.current.burn).toMatchObject({ tally: { burntRaw: 7_165_822529n } });

    spy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ jsonrpc: '2.0', id: 1, result: { context: { slot: 2 }, value: { amount: '999990000000000', decimals: 6 } } }],
    }) as unknown as Response);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.burn).toMatchObject({ tally: { burntRaw: 10_000_000000n } }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(wagmi.refetch).not.toHaveBeenCalled();
  });
});

describe('useBungalowBurn on a lot with no token', () => {
  it('is idle and reads nothing', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { result } = renderHook(() => useBungalowBurn(room('nb1')));
    expect(result.current.burn).toEqual({ status: 'idle' });
    expect(spy).not.toHaveBeenCalled();
    expect(wagmi.configs.every((c) => c.query?.enabled === false)).toBe(true);
  });
});
