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
 * CORRECTED 2026-09-17: the paragraph above describes a receipt wagmi never hands
 * back. Measured against a local anvil node with the installed @wagmi/core,
 * wagmi THROWS on a reverted receipt, so a revert arrives as `isError` with a
 * `CallExecutionError`, and `isSuccess` stays false. `landReceipt('reverted')`
 * below now produces that real shape. Until it did, every revert test here
 * exercised a branch production could not reach. See receiptOutcome in
 * lib/txErrors.ts, and receiptOutcome.test.ts for the real-wagmi pin.
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
  // The `.name` of wagmi's receipt-query error when `receiptQueryErrored`.
  receiptErrorName: 'CallExecutionError',
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
    // Real wagmi shape: the receipt lives on `data`, the failure on `error`.
    useWaitForTransactionReceipt: () => ({
      data: wagmiState.receiptQuerySucceeded
        ? { status: wagmiState.receiptStatus, transactionHash: wagmiState.hash, blockNumber: 21_000_000n }
        : undefined,
      isLoading: wagmiState.isConfirming,
      isSuccess: wagmiState.receiptQuerySucceeded,
      isError: wagmiState.receiptQueryErrored,
      error: wagmiState.receiptQueryErrored
        ? Object.assign(new Error('receipt query failed'), { name: wagmiState.receiptErrorName })
        : null,
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
    priceImpactUnread: false,
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
import { useAddLiquidity } from './useAddLiquidity';
import { useBribes } from './useBribes';
import { useRevenueStats } from './useRevenueStats';
import { useNFTDropV2 } from './useNFTDropV2';
import { useRestaking } from './useRestaking';
import { usePremiumAccess } from './usePremiumAccess';
import { DEFAULT_TOKENS } from '../lib/tokenList';
import { toast } from 'sonner';
import { trackStake, trackSwap } from '../lib/analytics';
import { CHAIN_ID } from '../lib/constants';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const OTHER_HASH = '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef' as `0x${string}`;
const HASH = '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' as `0x${string}`;

/**
 * Put the mock in the state real wagmi reaches when HASH's receipt settles.
 * A success comes back as data. A revert does NOT: wagmi replays the call for a
 * reason and throws, so the query errors with `CallExecutionError`.
 */
function landReceipt(status: 'success' | 'reverted') {
  wagmiState.hash = HASH;
  wagmiState.isConfirming = false;
  wagmiState.receiptStatus = status;
  wagmiState.receiptQuerySucceeded = status === 'success';
  wagmiState.receiptQueryErrored = status === 'reverted';
  wagmiState.receiptErrorName = 'CallExecutionError';
}

/**
 * Put the mock in "the node never returned HASH's receipt" state. Nothing is known
 * about what the transaction did: measured on an anvil node, a successful tx and a
 * reverted one both produce exactly this.
 */
function landUnreadableReceipt() {
  wagmiState.hash = HASH;
  wagmiState.isConfirming = false;
  wagmiState.receiptQuerySucceeded = false;
  wagmiState.receiptQueryErrored = true;
  wagmiState.receiptErrorName = 'TransactionReceiptNotFoundError';
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
    wagmiState.receiptQuerySucceeded = true;
    wagmiState.receiptQueryErrored = false;
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

/**
 * THE SAME MISTAKE, INVERTED, and the more expensive direction.
 *
 * The suite above pins "a revert must not render as success". This one pins the
 * mirror: A RECEIPT WE COULD NOT READ MUST NOT RENDER AS FAILED.
 *
 * When the node never returns a receipt, wagmi's receipt query errors with
 * `TransactionReceiptNotFoundError` (or an RPC error), whatever the transaction
 * did. Every hook here called that "Transaction failed" (useSwap called it
 * nothing, and left its Swap button dead). "Failed" tells the user to send it
 * again, and on an add, a stake or a swap that pays twice.
 *
 * The invariant is behavioural, not textual:
 *   receipt read failed  =>  no toast claiming failure
 *                        /\  a warning that says it may have succeeded
 *                        /\  the hash, and an explorer action to check it
 *                        /\  hook.isSuccess === false
 */
describe('an unreadable receipt must not render as failure', () => {
  const ALL_HOOKS: Array<{ name: string; use: () => { isSuccess: boolean } }> = [
    ...HOOKS,
    { name: 'useAddLiquidity', use: () => useAddLiquidity(DEFAULT_TOKENS[0], DEFAULT_TOKENS[1]) },
    { name: 'useBribes', use: () => useBribes() },
    { name: 'useRevenueStats', use: () => useRevenueStats() },
    { name: 'useNFTDropV2', use: () => useNFTDropV2('0x4242424242424242424242424242424242424242') },
    { name: 'useRestaking', use: () => useRestaking() },
    { name: 'usePremiumAccess', use: () => usePremiumAccess() },
  ];

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
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.info).mockClear();
    try { window.localStorage.clear(); } catch { /* jsdom only */ }
  });

  for (const { name, use } of ALL_HOOKS) {
    it(`${name}: an unreadable receipt is never called a failure`, () => {
      landUnreadableReceipt();
      renderHook(use);
      const claims = vi.mocked(toast.error).mock.calls.map(([msg]) => String(msg));
      expect(
        claims.filter((m) => /fail|revert|reject/i.test(m)),
        'the hook claimed the transaction failed, but all that failed was our read of the ' +
          'receipt. That claim is an instruction to resend, and a resend pays twice.',
      ).toEqual([]);
    });

    it(`${name}: an unreadable receipt says it may have succeeded, with somewhere to check`, () => {
      landUnreadableReceipt();
      renderHook(use);
      const calls = vi.mocked(toast.warning).mock.calls;
      expect(calls.length, 'the hook said nothing at all about a terminal transaction').toBeGreaterThan(0);
      const [title, opts] = calls[0] as [string, Record<string, unknown> | undefined];
      expect(title).toMatch(/(couldn.?t|could not|cannot|unable to) confirm/i);
      const description = String(opts?.description ?? '');
      expect(description, 'the copy does not say the transaction may have succeeded').toMatch(/may well have succeeded/i);
      expect(description, 'the copy does not warn the user to check before resending').toMatch(/before you send it again/i);
      expect(description, 'the copy does not name WHICH transaction to check').toMatch(/0x[0-9a-fA-F]{6,}/);
      expect(opts?.action, 'no explorer action: nowhere for the user to go and read it themselves').toBeTruthy();
    });

    it(`${name}: an unreadable receipt is not a success either`, () => {
      landUnreadableReceipt();
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(false);
      expect(toast.success).not.toHaveBeenCalled();
    });

    // Control: the uncertainty warning belongs to THIS branch alone. A revert is a
    // receipt wagmi DID read, and "it may well have succeeded" would be a lie there.
    it(`${name}: a revert still gets a revert message, not the unconfirmed warning`, () => {
      landReceipt('reverted');
      renderHook(use);
      expect(toast.warning).not.toHaveBeenCalled();
      const titles = vi.mocked(toast.error).mock.calls.map(([msg]) => String(msg));
      expect(titles.some((m) => /reverted/i.test(m)), `no revert message, got ${JSON.stringify(titles)}`).toBe(true);
    });
  }
});
