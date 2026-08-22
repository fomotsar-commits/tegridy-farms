// EIP-5792 approve+stake — capability detection and the fallback contract.
//
// The whole safety property of this hook is negative: it must never claim a
// wallet can batch. `canBatch` false is the sequential approve → stake flow,
// which is the proven path; `canBatch` true routes a user's money through
// wallet_sendCalls. So every case below that expects `false` is the important
// one, and the wallets that answer `wallet_getCapabilities` with garbage, a
// rejection, or a different chain are exactly the ones that were never exercised
// while this hook sat unmounted.
//
// This file mocks wagmi locally rather than using test-utils/wagmi-mocks: the
// shared mock's useAccount exposes no `connector`, and the connector's provider
// IS the surface under test here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { CHAIN_ID } from '../lib/constants';
import { TOWELI_ADDRESS, TEGRIDY_STAKING_ADDRESS } from '../lib/constants';

const WALLET = '0x1111111111111111111111111111111111111111' as const;

const state = vi.hoisted(() => ({
  address: undefined as `0x${string}` | undefined,
  chainId: 1,
  request: null as null | ((args: { method: string; params?: unknown[] }) => Promise<unknown>),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: state.address,
    connector: state.request
      ? { getProvider: () => Promise.resolve({ request: state.request! }) }
      : undefined,
  }),
  useChainId: () => state.chainId,
}));

import { useOneClickStake } from './useOneClickStake';

/** Install an EIP-1193 stub whose responses are keyed by RPC method. */
function stubProvider(handlers: Record<string, unknown | (() => Promise<unknown>)>): void {
  state.request = async ({ method }) => {
    const h = handlers[method];
    if (h === undefined) throw new Error(`Unsupported method: ${method}`);
    return typeof h === 'function' ? await (h as () => Promise<unknown>)() : h;
  };
}

/** Let the capability-probe effect's promise chain settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('useOneClickStake — capability detection', () => {
  beforeEach(() => {
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.request = null;
    vi.restoreAllMocks();
  });

  it('offers the one-click path when the wallet advertises atomic mainnet batching', async () => {
    stubProvider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'supported' } } } });
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(true);
  });

  it("accepts 'ready' — a one-time upgrade prompt is still a one-click path", async () => {
    stubProvider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'ready' } } } });
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(true);
  });

  it('refuses when the wallet reports the capability as unsupported', async () => {
    stubProvider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'unsupported' } } } });
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(false);
  });

  it('refuses when wallet_getCapabilities throws — the common case, not an edge case', async () => {
    stubProvider({ wallet_getCapabilities: () => Promise.reject(new Error('Method not found')) });
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(false);
  });

  it('refuses on a garbage capabilities payload rather than reading it optimistically', async () => {
    for (const payload of [null, 'yes', 42, [], { '0x1': { atomic: 'supported' } }]) {
      stubProvider({ wallet_getCapabilities: payload });
      const { result } = renderHook(() => useOneClickStake());
      await settle();
      expect(result.current.canBatch).toBe(false);
    }
  });

  it('refuses when the wallet advertises batching on a chain that is not mainnet', async () => {
    stubProvider({ wallet_getCapabilities: { '0x2105': { atomic: { status: 'supported' } } } });
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(false);
  });

  it('refuses while the wallet is on the wrong chain, however capable it is', async () => {
    state.chainId = 8453;
    stubProvider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'supported' } } } });
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(false);
  });

  it('refuses with no wallet connected', async () => {
    state.address = undefined;
    state.request = null;
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    expect(result.current.canBatch).toBe(false);
  });
});

describe('useOneClickStake — the batch it actually sends', () => {
  beforeEach(() => {
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.request = null;
  });

  it('sends approve-then-stake to the right two contracts and returns the batch id', async () => {
    const sent: Array<{ method: string; params?: unknown[] }> = [];
    state.request = async (args) => {
      sent.push(args);
      if (args.method === 'wallet_getCapabilities') return { '0x1': { atomic: { status: 'supported' } } };
      return { id: '0xbatch' };
    };

    const { result } = renderHook(() => useOneClickStake());
    await settle();

    const id = await result.current.stakeOneClick(10n ** 18n, 7776000n);
    expect(id).toBe('0xbatch');

    const call = sent.find((s) => s.method === 'wallet_sendCalls');
    const params = (call?.params as [Record<string, unknown>])[0];
    expect(params.from).toBe(WALLET);
    expect(params.chainId).toBe('0x1');
    const calls = params.calls as Array<{ to: string }>;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to.toLowerCase()).toBe(TOWELI_ADDRESS.toLowerCase());
    expect(calls[1]!.to.toLowerCase()).toBe(TEGRIDY_STAKING_ADDRESS.toLowerCase());
  });

  it('throws instead of sending when the wallet is on the wrong chain', async () => {
    stubProvider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'supported' } } } });
    state.chainId = 8453;
    const { result: wrongChain } = renderHook(() => useOneClickStake());
    await settle();
    await expect(wrongChain.current.stakeOneClick(10n ** 18n, 7776000n)).rejects.toThrow(/network/i);
  });

  it('propagates a wallet rejection so the caller can leave the user on the normal flow', async () => {
    state.request = async (args) => {
      if (args.method === 'wallet_getCapabilities') return { '0x1': { atomic: { status: 'supported' } } };
      throw Object.assign(new Error('User rejected the request'), { code: 4001 });
    };
    const { result } = renderHook(() => useOneClickStake());
    await settle();
    await expect(result.current.stakeOneClick(10n ** 18n, 7776000n)).rejects.toThrow(/rejected/i);
  });
});
