/**
 * Regression suite: a REVERTED transaction must never render as success.
 *
 * wagmi's `useWaitForTransactionReceipt().isSuccess` means "the receipt was
 * FETCHED", not "the transaction succeeded" — an on-chain revert still mines a
 * receipt, with `receipt.status === 'reverted'`. Every money path in
 * useFarmActions / useLPFarming / useSwap keyed its success toast (and, via the
 * returned `isSuccess`, the confetti + receipt modal on FarmPage/TradePage) off
 * that flag alone, so a stake/withdraw/claim/swap that moved nothing showed
 * "confirmed".
 *
 * The invariant pinned here is behavioural, not textual:
 *   receipt.status !== 'success'  ⇒  hook.isSuccess === false
 *                                 ∧  no toast.success
 *                                 ∧  an actionable toast.error
 * Success controls prove the happy path still works, so the fix can't be a
 * blanket "never succeed".
 *
 * The shared scaffold at ../test-utils/wagmi-mocks does not model the receipt
 * object at all (its useWaitForTransactionReceipt returns no `data`), so this
 * file inlines its own wagmi mock shaped like the REAL hook rather than
 * changing a scaffold other suites depend on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const wagmiState = vi.hoisted(() => ({
  chainId: 1,
  account: { address: undefined as `0x${string}` | undefined, isConnected: false },
  hash: undefined as `0x${string}` | undefined,
  isPending: false,
  isConfirming: false,
  // Mirrors wagmi: `receiptQuerySucceeded` is `isSuccess`, and it is true for a
  // reverted tx too. `receiptStatus` is what lands on `data.status`.
  receiptQuerySucceeded: false,
  receiptQueryErrored: false,
  receiptStatus: 'success' as 'success' | 'reverted',
  writeContractMock: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('wagmi', async () => {
  const { vi: vitest } = await import('vitest');
  if (!wagmiState.writeContractMock) wagmiState.writeContractMock = vitest.fn();
  return {
    useAccount: () => ({
      address: wagmiState.account.address,
      isConnected: wagmiState.account.isConnected,
      chain: { id: wagmiState.chainId },
    }),
    useChainId: () => wagmiState.chainId,
    useReadContract: () => ({
      data: undefined, error: undefined, isLoading: false, isError: false, refetch: vitest.fn(),
    }),
    useReadContracts: (opts: { contracts?: unknown[] }) => ({
      data: (opts?.contracts ?? []).map(() => ({ status: 'failure' as const, error: new Error('no stub') })),
      error: undefined, isLoading: false, isError: false, refetch: vitest.fn(),
    }),
    useBalance: () => ({ data: undefined, refetch: vitest.fn() }),
    usePublicClient: () => ({
      readContract: vitest.fn().mockResolvedValue(0n),
      multicall: vitest.fn().mockResolvedValue([]),
    }),
    useWriteContract: () => ({
      writeContract: wagmiState.writeContractMock,
      data: wagmiState.hash,
      isPending: wagmiState.isPending,
      error: undefined,
      reset: vitest.fn(),
    }),
    useWatchContractEvent: () => undefined,
    // Real wagmi shape: the receipt lives on `data`, and `isSuccess` is true
    // whenever the receipt was retrieved — reverted or not.
    useWaitForTransactionReceipt: () => ({
      data: wagmiState.receiptQuerySucceeded
        ? { status: wagmiState.receiptStatus, transactionHash: wagmiState.hash, blockNumber: 21_000_000n }
        : undefined,
      isLoading: wagmiState.isConfirming,
      isSuccess: wagmiState.receiptQuerySucceeded,
      isError: wagmiState.receiptQueryErrored,
    }),
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));
vi.mock('../lib/analytics', () => ({ trackStake: vi.fn(), trackSwap: vi.fn() }));
vi.mock('../lib/revertDecoder', () => ({ decodeRevertReason: (e: Error) => e?.message ?? 'err' }));

vi.mock('./useSwapQuote', () => ({
  QUOTE_MAX_AGE_MS: 30_000,
  useSwapQuote: () => ({
    outputAmount: 1000n * 10n ** 18n,
    outputFormatted: '1000',
    priceImpact: 0.5,
    minimumReceived: 990n * 10n ** 18n,
    minimumReceivedFormatted: '990',
    isQuoteLoading: false,
    selectedRoute: 'uniswap' as const,
    selectedOnChainRoute: { source: 'uniswap' as const, output: 1000n * 10n ** 18n },
    hasTegridyPair: true,
    tegridyOutputFormatted: '1000',
    uniOutputFormatted: '1000',
    aggBetter: false,
    aggOutputFormatted: null,
    bestAggregatorName: null,
    allAggQuotes: [],
    routeDescription: ['Uniswap V2'],
    routeLabel: 'Uniswap V2',
    hasDirectPair: true,
    intermediateAmount: undefined,
    path: [] as `0x${string}`[],
    isQuoteStale: false,
    quoteFetchedAt: Date.now(),
    refreshQuote: vi.fn(),
  }),
}));

vi.mock('./useSwapAllowance', () => ({
  useSwapAllowance: () => ({
    needsApproval: false,
    approve: vi.fn(),
    unlimitedApproval: false,
    toggleUnlimitedApproval: vi.fn(),
    refetchAllowance: vi.fn(),
    isApprovingMultiStep: false,
    continueMultiStepApprove: () => false,
    resetMultiStepApprove: vi.fn(),
  }),
}));

import { useFarmActions } from './useFarmActions';
import { useLPFarming } from './useLPFarming';
import { useSwap } from './useSwap';
import { toast } from 'sonner';
import { trackStake, trackSwap } from '../lib/analytics';
import { CHAIN_ID } from '../lib/constants';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const OTHER_HASH = '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef' as `0x${string}`;
const HASH = '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' as `0x${string}`;

/** Put the mock in "a receipt has come back for HASH" state. */
function landReceipt(status: 'success' | 'reverted') {
  wagmiState.hash = HASH;
  wagmiState.isConfirming = false;
  wagmiState.receiptQuerySucceeded = true; // wagmi latches this for BOTH outcomes
  wagmiState.receiptQueryErrored = false;
  wagmiState.receiptStatus = status;
}

const HOOKS: Array<{ name: string; use: () => { isSuccess: boolean } }> = [
  { name: 'useFarmActions', use: () => useFarmActions() },
  { name: 'useLPFarming', use: () => useLPFarming() },
  { name: 'useSwap', use: () => useSwap() },
];

describe('reverted receipts must not render as success', () => {
  beforeEach(() => {
    wagmiState.chainId = CHAIN_ID;
    wagmiState.account = { address: USER, isConnected: true };
    wagmiState.hash = undefined;
    wagmiState.isPending = false;
    wagmiState.isConfirming = false;
    wagmiState.receiptQuerySucceeded = false;
    wagmiState.receiptQueryErrored = false;
    wagmiState.receiptStatus = 'success';
    wagmiState.writeContractMock?.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    vi.mocked(trackStake).mockClear();
    vi.mocked(trackSwap).mockClear();
    try { window.localStorage.clear(); } catch { /* jsdom only */ }
  });

  for (const { name, use } of HOOKS) {
    it(`${name}: receipt.status 'reverted' does NOT report success`, () => {
      landReceipt('reverted');
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(false);
    });

    it(`${name}: receipt.status 'reverted' fires no success toast`, () => {
      landReceipt('reverted');
      renderHook(use);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it(`${name}: receipt.status 'reverted' surfaces an actionable error`, () => {
      landReceipt('reverted');
      renderHook(use);
      expect(toast.error).toHaveBeenCalled();
      const [, opts] = vi.mocked(toast.error).mock.calls[0] as [string, Record<string, unknown> | undefined];
      // "Actionable" = the user is given somewhere to go (explorer link) and
      // told what to do next, not just a dead-end "failed".
      expect(opts?.action).toBeTruthy();
      expect(typeof opts?.description).toBe('string');
      expect((opts?.description as string).length).toBeGreaterThan(0);
    });

    // Control: the fix must not be "never succeed".
    it(`${name}: receipt.status 'success' still reports success`, () => {
      landReceipt('success');
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(true);
      expect(toast.success).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  }

  it('useFarmActions: a reverted stake is not sent to analytics — now or later', () => {
    const { result, rerender } = renderHook(() => useFarmActions());
    // Put a real stake in flight so pendingStakeRef is populated.
    act(() => result.current.stake('10', 86400n));
    expect(wagmiState.writeContractMock).toHaveBeenCalledTimes(1);

    landReceipt('reverted');
    rerender();
    expect(trackStake).not.toHaveBeenCalled();

    // …and the dead stake must not be resurrected by the NEXT tx that succeeds.
    wagmiState.hash = OTHER_HASH;
    wagmiState.receiptStatus = 'success';
    rerender();
    expect(trackStake).not.toHaveBeenCalled();
  });

  it('useSwap: a reverted swap is not sent to analytics', () => {
    landReceipt('reverted');
    renderHook(() => useSwap());
    expect(trackSwap).not.toHaveBeenCalled();
  });

  it('useFarmActions / useSwap: a reverted receipt is also an error state', () => {
    landReceipt('reverted');
    const farm = renderHook(() => useFarmActions());
    expect(farm.result.current.isTxError).toBe(true);
    const swap = renderHook(() => useSwap());
    expect(swap.result.current.isTxError).toBe(true);
  });
});
