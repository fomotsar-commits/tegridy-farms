// A pending opening is a liquidity note like the other two (spec N14): it lives in the
// one 'lp:pending' scope, survives a reload WITH its pool, and is written the moment it
// is sent. A list of liquidity kinds written out by hand in either file would drop its
// pool, and the tab could then not say which pool it opened.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { KEY, SIG, fakeApi, prepared } from './fakeWriteApi.fixture';
import { LP_PENDING_SCOPE, readPendingTrades, savePendingTrade } from './pendingTrade';
import { usePendingTrades, type CheckSignature } from './usePendingTrades';
import { useTxFlow } from './useTxFlow';
import type { CurveWriteConfig, PreparedTx, TxSummary, WriteRpc } from './ports';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';

const POOL = KEY(40);
const CFG = { programId: KEY(50), cpSwapProgram: KEY(51), cluster: 'localnet' } as CurveWriteConfig;
const SIG2 = '4'.repeat(88);

const createSummary = (): TxSummary => ({
  kind: 'lp-create',
  pool: POOL,
  origin: 'other',
  config: {
    address: KEY(6).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n,
    fundFeeRate: 0n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: KEY(7).toBase58(), fundOwner: KEY(7).toBase58(),
  },
  tokenMint: KEY(41),
  tokenDecimals: 6,
  quote: SOL_QUOTE,
  quoteIsToken0: true,
  put: { quote: 1_000_000_000n, token: 5_000_000n },
  supply: 70_710_678n,
  lpAmount: 70_710_578n,
  lpDecimals: 9,
  locked: { quote: 1_414n, token: 7n },
  createFee: 150_000_000n,
  feeReceiver: KEY(8),
  rents: { neverRefunded: 40_000_000n, lpAccount: 2_039_280n },
  price: { state: 'agrees', pool: 0.2, reference: 0.2, against: 'outside', diff: 0 },
  tokenWarnings: [],
  unwrapsWsol: true,
  wsolHeldBefore: 0n,
  notices: [],
});

beforeEach(() => sessionStorage.clear());

describe('a pending opening', () => {
  it('survives a reload read with its pool', () => {
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-create', signature: SIG, lastValidBlockHeight: 99, pool: POOL.toBase58() });
    expect(readPendingTrades(LP_PENDING_SCOPE)).toMatchObject([{ kind: 'lp-create', signature: SIG, lastValidBlockHeight: 99, pool: POOL.toBase58() }]);
    expect(JSON.parse(sessionStorage.getItem(LP_PENDING_SCOPE) ?? '[]')).toMatchObject([{ kind: 'lp-create', pool: POOL.toBase58() }]);
  });

  it('is written the moment it is sent, with its pool', () => {
    const { result } = renderHook(() => usePendingTrades(LP_PENDING_SCOPE, null, vi.fn()));
    act(() => result.current.sent(SIG2, prepared(createSummary())));
    expect(readPendingTrades(LP_PENDING_SCOPE)).toMatchObject([{ kind: 'lp-create', signature: SIG2, pool: POOL.toBase58() }]);
  });

  it('left unknown, it is kept with its pool; confirmed, it is cleared', () => {
    const { result } = renderHook(() => usePendingTrades(LP_PENDING_SCOPE, null, vi.fn()));
    act(() => result.current.record({ status: 'unknown', signature: SIG, message: 'slow' }, prepared(createSummary())));
    expect(readPendingTrades(LP_PENDING_SCOPE)).toMatchObject([{ kind: 'lp-create', pool: POOL.toBase58() }]);
    act(() => result.current.record({ status: 'confirmed', signature: SIG, slot: 1 }, prepared(createSummary())));
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);
  });

  it('its check is told it is an opening, so a refusal is said in the opening’s words', async () => {
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-create', signature: SIG, lastValidBlockHeight: 99, pool: POOL.toBase58() });
    const check = vi.fn<CheckSignature>(async (signature) => ({ status: 'unknown' as const, signature, message: 'still out there' }));
    // The check runs on arrival, before any form the note holds is shown.
    const { result } = renderHook(() => usePendingTrades(LP_PENDING_SCOPE, check, vi.fn()));
    await waitFor(() => expect(check).toHaveBeenCalledWith(SIG, 99, 'lp-create'));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.notes).toMatchObject([{ kind: 'lp-create', pool: POOL.toBase58() }]);
  });

  it('Check again on the panel passes the opening’s config and kind', async () => {
    const api = fakeApi({
      submitPrepared: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
      recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'slow' })),
    });
    const { result } = renderHook(() => useTxFlow(api, {} as WriteRpc));
    const p = prepared(createSummary(), { check: { intent: { cfg: CFG } } as unknown as PreparedTx['check'] });
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: p })));
    await act(() => result.current.confirm({ publicKey: KEY(2), signTransaction: async (t) => t }));
    await act(() => result.current.recheck());
    expect(api.recheckOutcome).toHaveBeenCalledWith({}, SIG, { lastValidBlockHeight: 1234, cfg: CFG, kind: 'lp-create' });
  });
});
