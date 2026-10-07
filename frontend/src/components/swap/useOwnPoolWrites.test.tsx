// The swap page's write path to our pools: its code loads only when a pool of ours quotes
// the pair for a connected wallet (or a note of an earlier trade stands), and Buy is told
// in plain words when a trade there cannot be sent from this page.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { GateRpc, LpGate, LpWriteApi } from '../solana/curve/ports';

const h = vi.hoisted(() => ({ wallet: { publicKey: null as unknown, signTransaction: undefined as unknown } }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: {} }),
  useWallet: () => ({ ...h.wallet, signMessage: undefined, connecting: false, wallet: null }),
}));

import { OWN_SEND_COPY, useOwnPoolWrites } from './useOwnPoolWrites';
import { fakeLpApi, lpCfg, lpOpenGate, LP_PROGRAM } from '../solana/lp/fakeLpWriteApi.fixture';
import { SWAP_PENDING_SCOPE, savePendingTrade } from '../solana/curve/pendingTrade';

const gateRpc = {} as GateRpc;
const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const connect = (canSign = true) => {
  h.wallet = { publicKey: USER, signTransaction: canSign ? async <T,>(t: T) => t : undefined };
};

function mount(o: { wanted: boolean; gate?: LpGate; load?: () => Promise<LpWriteApi> }) {
  const api = fakeLpApi({ gate: o.gate ?? lpOpenGate(), recheckOutcome: vi.fn(async (_r, signature: string) => ({ status: 'unknown' as const, signature, message: 'slow' })) });
  const load = o.load ?? vi.fn(async () => api);
  const hook = renderHook(() => useOwnPoolWrites({ wanted: o.wanted, onResolved: vi.fn(), load, gateRpc, programId: LP_PROGRAM }));
  return { ...hook, load, api };
}

beforeEach(() => {
  sessionStorage.clear();
  h.wallet = { publicKey: null, signTransaction: undefined };
});

describe('useOwnPoolWrites', () => {
  it('loads no write code until a pool of ours quotes the pair', () => {
    connect();
    const { result, load } = mount({ wanted: false });
    expect(load).not.toHaveBeenCalled();
    expect(result.current.send).toEqual({ kind: 'checking' });
  });

  it('with a pool of ours and an open gate on the same program, a trade there can be sent', async () => {
    connect();
    const { result, api } = mount({ wanted: true });
    await waitFor(() => expect(result.current.send).toEqual({ kind: 'yes' }));
    expect(result.current.api).toBe(api);
    expect(result.current.gate).toMatchObject({ kind: 'open', mode: 'on' });
    expect(result.current.signer?.publicKey).toBe(USER);
  });

  it('says why when it cannot: paused, another program, unloaded code, a wallet that cannot sign', async () => {
    connect();
    const paused = mount({ wanted: true, gate: lpOpenGate({ mode: 'withdraw-only' }) });
    await waitFor(() => expect(paused.result.current.send).toEqual({ kind: 'no', reason: OWN_SEND_COPY.paused }));
    expect(paused.result.current.gate).toBeNull();
    const blocked = mount({ wanted: true, gate: { kind: 'blocked', reason: 'unreadable', detail: 'x' } });
    await waitFor(() => expect(blocked.result.current.send).toEqual({ kind: 'no', reason: OWN_SEND_COPY.paused }));
    const other = mount({ wanted: true, gate: lpOpenGate({ cfg: lpCfg('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y') }) });
    await waitFor(() => expect(other.result.current.send).toEqual({ kind: 'no', reason: OWN_SEND_COPY.otherProgram }));
    expect(other.result.current.gate).toBeNull();
    const failed = mount({ wanted: true, load: async () => Promise.reject(new Error('chunk 404')) });
    await waitFor(() => expect(failed.result.current.send).toEqual({ kind: 'no', reason: OWN_SEND_COPY.notLoaded }));
    connect(false);
    const noSign = mount({ wanted: true });
    expect(noSign.result.current.send).toEqual({ kind: 'no', reason: OWN_SEND_COPY.cannotSign });
  });

  it('with no wallet, Buy is not pressable anyway: the line says what it would do', () => {
    const { result } = mount({ wanted: true });
    expect(result.current.send).toEqual({ kind: 'yes' });
  });

  it('a note of an earlier trade loads the write code to check it, with no pool on screen', async () => {
    savePendingTrade(SWAP_PENDING_SCOPE, { kind: 'venue-swap', signature: '5'.repeat(88), lastValidBlockHeight: 9 });
    const { result, load, api } = mount({ wanted: false });
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect(api.recheckOutcome).toHaveBeenCalledWith({}, '5'.repeat(88), expect.objectContaining({ kind: 'venue-swap', lastValidBlockHeight: 9 })));
    expect(result.current.pending.notes).toHaveLength(1);
  });
});
