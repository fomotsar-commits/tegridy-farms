/**
 * Regression suite: a transaction's three terminal outcomes must each read as
 * themselves — success, revert, and "we could not read the receipt".
 *
 * HOW WAGMI ACTUALLY DELIVERS A REVERT (measured 2026-09-17, @wagmi/core 3.6.5):
 * it does not return one. `waitForTransactionReceipt` THROWS on
 * `status === 'reverted'`, so a real revert arrives as `isError` with `data`
 * undefined, the same flag as a receipt READ failure. This suite's first version
 * modelled a revert as `isSuccess` + `data.status: 'reverted'`, a shape wagmi 3
 * never produces, so it stayed green while every hook's revert branch was
 * unreachable. The revert suite below now runs against BOTH shapes, the thrown
 * one first; lib/txErrors.receipt.test.ts pins the thrown shape against the real
 * library.
 *
 * wagmi's `useWaitForTransactionReceipt().isSuccess` means "the receipt was
 * FETCHED", not "the transaction succeeded". Every money path in
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
  // What wagmi puts on `error` when `isError` is set. The hooks tell a revert
  // from an unreadable receipt by this alone.
  receiptError: undefined as unknown,
  // A same-nonce transaction from the same wallet that confirmed INSTEAD of
  // `hash`. viem does not fail the wait for it: it resolves with the
  // replacement's receipt, and says why only through `onReplaced`, which the
  // mock calls as viem does, if the hook passed one (`silent`: it never runs).
  replacement: undefined as
    | { hash: `0x${string}`; reason: 'cancelled' | 'replaced' | 'repriced'; silent?: boolean }
    | undefined,
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
    // Funded, so useSwap's `insufficientBalance` gate cannot be what stops a second
    // executeSwap in the latch tests below.
    useBalance: () => ({ data: { value: 10n ** 24n, decimals: 18, symbol: 'ETH' }, refetch: vitest.fn() }),
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
    useWaitForTransactionReceipt: (opts?: { onReplaced?: (r: unknown) => void }) => {
      const { replacement } = wagmiState;
      const data = wagmiState.receiptQuerySucceeded
        ? {
            status: wagmiState.receiptStatus,
            transactionHash: replacement?.hash ?? wagmiState.hash,
            blockNumber: 21_000_000n,
          }
        : undefined;
      if (data && replacement && !replacement.silent) {
        opts?.onReplaced?.({
          reason: replacement.reason,
          replacedTransaction: { hash: wagmiState.hash },
          transaction: { hash: replacement.hash },
          transactionReceipt: data,
        });
      }
      return {
        data,
        isLoading: wagmiState.isConfirming,
        isSuccess: wagmiState.receiptQuerySucceeded,
        isError: wagmiState.receiptQueryErrored,
        error: wagmiState.receiptQueryErrored ? wagmiState.receiptError : null,
      };
    },
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
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError } from 'viem';
import { trackStake, trackSwap } from '../lib/analytics';
import { CHAIN_ID } from '../lib/constants';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const OTHER_HASH = '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef' as `0x${string}`;
const HASH = '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' as `0x${string}`;

/** Put the mock in "a receipt has come back for HASH" state, delivered as DATA. */
function landReceipt(status: 'success' | 'reverted') {
  wagmiState.hash = HASH;
  wagmiState.isConfirming = false;
  wagmiState.receiptQuerySucceeded = true;
  wagmiState.receiptQueryErrored = false;
  wagmiState.receiptError = undefined;
  wagmiState.receiptStatus = status;
}

/**
 * A genuine on-chain revert, in either shape it can arrive in.
 *
 * `thrown` is what @wagmi/core 3 does: it reads the reverted receipt, replays the
 * tx with `call` for a reason, and THROWS the resulting CallExecutionError. `data`
 * is the older assumption (a reverted receipt on `data`), kept because the hooks
 * still honour it and it costs nothing to keep true.
 */
type RevertShape = 'thrown' | 'data';
function landRevert(shape: RevertShape) {
  if (shape === 'data') { landReceipt('reverted'); return; }
  wagmiState.hash = HASH;
  wagmiState.isConfirming = false;
  wagmiState.receiptQuerySucceeded = false;
  wagmiState.receiptQueryErrored = true;
  wagmiState.receiptError = new CallExecutionError(
    new ExecutionRevertedError({ message: 'execution reverted' }),
    {},
  );
}

/**
 * Put the mock in "the receipt READ failed" state - wagmi's `isError` with a viem
 * read error on `error`.
 *
 * Nothing whatever is known about what the transaction did. Measured on an anvil
 * fork 2026-09-10 by answering every `eth_getTransactionReceipt` with
 * `{result: null}` - an addLiquidityETH that was mined and SUCCESSFUL reported
 * "Transaction failed". That fault throws exactly this error type.
 */
function landUnreadableReceipt() {
  wagmiState.hash = HASH;
  wagmiState.isConfirming = false;
  wagmiState.receiptQuerySucceeded = false;
  wagmiState.receiptQueryErrored = true;
  wagmiState.receiptError = new TransactionReceiptNotFoundError({ hash: HASH });
}

function resetMocks() {
  wagmiState.chainId = CHAIN_ID;
  wagmiState.account = { address: USER, isConnected: true };
  wagmiState.hash = undefined;
  wagmiState.isPending = false;
  wagmiState.isConfirming = false;
  wagmiState.receiptQuerySucceeded = false;
  wagmiState.receiptQueryErrored = false;
  wagmiState.receiptError = undefined;
  wagmiState.receiptStatus = 'success';
  wagmiState.replacement = undefined;
  wagmiState.writeContractMock?.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(trackStake).mockClear();
  vi.mocked(trackSwap).mockClear();
  try { window.localStorage.clear(); } catch { /* jsdom only */ }
}

const HOOKS: Array<{ name: string; use: () => { isSuccess: boolean } }> = [
  { name: 'useFarmActions', use: () => useFarmActions() },
  { name: 'useLPFarming', use: () => useLPFarming() },
  { name: 'useSwap', use: () => useSwap() },
];

/** Every surface whose receipt handling this file pins. */
const ALL_HOOKS: Array<{ name: string; use: () => { isSuccess: boolean } }> = [
  ...HOOKS,
  { name: 'useAddLiquidity', use: () => useAddLiquidity(DEFAULT_TOKENS[0], DEFAULT_TOKENS[1]) },
  { name: 'useBribes', use: () => useBribes() },
  { name: 'useRevenueStats', use: () => useRevenueStats() },
  { name: 'useNFTDropV2', use: () => useNFTDropV2('0x00000000000000000000000000000000000d7009') },
  { name: 'useRestaking', use: () => useRestaking() },
  { name: 'usePremiumAccess', use: () => usePremiumAccess() },
];

const SHAPES: Array<{ shape: RevertShape; label: string }> = [
  { shape: 'thrown', label: 'thrown by wagmi (how wagmi 3 delivers it)' },
  { shape: 'data', label: "delivered as data.status 'reverted'" },
];

for (const { shape, label } of SHAPES) {
  describe(`reverted receipts must not render as success — ${label}`, () => {
    beforeEach(resetMocks);

    for (const { name, use } of HOOKS) {
      it(`${name}: a revert does NOT report success`, () => {
        landRevert(shape);
        const { result } = renderHook(use);
        expect(result.current.isSuccess).toBe(false);
      });

      it(`${name}: a revert fires no success toast`, () => {
        landRevert(shape);
        renderHook(use);
        expect(toast.success).not.toHaveBeenCalled();
      });

      it(`${name}: a revert surfaces an actionable error`, () => {
        landRevert(shape);
        renderHook(use);
        expect(toast.error).toHaveBeenCalled();
        const [, opts] = vi.mocked(toast.error).mock.calls[0] as [string, Record<string, unknown> | undefined];
        // "Actionable" = the user is given somewhere to go (explorer link) and
        // told what to do next, not just a dead-end "failed".
        expect(opts?.action).toBeTruthy();
        expect(typeof opts?.description).toBe('string');
        expect((opts?.description as string).length).toBeGreaterThan(0);
      });
    }

    // Every surface, not just the three above: a revert says REVERTED and never
    // borrows the unconfirmed copy. "We can't tell whether it went through" is
    // false about a receipt we read, and the honest advice there is the opposite:
    // nothing moved, so fixing it and trying again is safe.
    for (const { name, use } of ALL_HOOKS) {
      it(`${name}: a revert gets the revert message, not the unconfirmed one`, () => {
        landRevert(shape);
        renderHook(use);
        expect(toast.warning, 'a revert was told it could not be confirmed').not.toHaveBeenCalled();
        const titles = vi.mocked(toast.error).mock.calls.map(([msg]) => String(msg));
        expect(
          titles.some((t) => /revert/i.test(t)),
          `no toast said the transaction reverted. Toasts: ${JSON.stringify(titles)}`,
        ).toBe(true);
        expect(titles.filter((t) => /^transaction failed/i.test(t))).toEqual([]);
      });
    }

    it('useFarmActions: a reverted stake is not sent to analytics — now or later', () => {
      const { result, rerender } = renderHook(() => useFarmActions());
      // Put a real stake in flight so pendingStakeRef is populated.
      act(() => result.current.stake('10', 86400n));
      expect(wagmiState.writeContractMock).toHaveBeenCalledTimes(1);

      landRevert(shape);
      rerender();
      expect(trackStake).not.toHaveBeenCalled();

      // …and the dead stake must not be resurrected by the NEXT tx that succeeds.
      landReceipt('success');
      wagmiState.hash = OTHER_HASH;
      rerender();
      expect(trackStake).not.toHaveBeenCalled();
    });

    it('useSwap: a reverted swap is not sent to analytics', () => {
      landRevert(shape);
      renderHook(() => useSwap());
      expect(trackSwap).not.toHaveBeenCalled();
    });

    it('useFarmActions / useSwap: a reverted receipt is also an error state', () => {
      landRevert(shape);
      const farm = renderHook(() => useFarmActions());
      expect(farm.result.current.isTxError).toBe(true);
      const swap = renderHook(() => useSwap());
      expect(swap.result.current.isTxError).toBe(true);
    });
  });
}

describe('a successful receipt still reports success', () => {
  beforeEach(resetMocks);

  // Control: the fix must not be "never succeed".
  for (const { name, use } of HOOKS) {
    it(`${name}: receipt.status 'success' still reports success`, () => {
      landReceipt('success');
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(true);
      expect(toast.success).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });
  }
});

/**
 * THE SAME MISTAKE, INVERTED - and the more expensive direction.
 *
 * The suites above pin "a revert must not render as success". This one pins the
 * mirror: A RECEIPT WE COULD NOT READ MUST NOT RENDER AS FAILED.
 *
 * Every hook here surfaced wagmi's `isError` as "Transaction failed" (useSwap as
 * nothing at all). "Failed" is an instruction: it tells the user to send it again,
 * and on an add, a stake or a swap that pays twice. Nor may it say the transaction
 * "may have succeeded": a real revert whose receipt read also failed lands here
 * too (measured, see lib/txErrors.ts). The only honest statement is that we
 * cannot tell.
 *
 * Reproducible end to end: e2e/liquidity.spec.ts, e2e/stake.spec.ts and
 * e2e/swap.spec.ts drive this branch on an anvil fork via `blindReceiptReads` and
 * assert the transaction SUCCEEDED on chain while the app was told nothing.
 *
 *   receipt read failed  =>  no toast claiming failure, revert or success
 *                        /\  a warning that says we cannot tell
 *                        /\  somewhere to go and check (explorer action + hash)
 *                        /\  hook.isSuccess === false
 */
describe('an unreadable receipt must not render as failure', () => {
  beforeEach(resetMocks);

  for (const { name, use } of ALL_HOOKS) {
    it(name + ': an unreadable receipt is never called a failure', () => {
      landUnreadableReceipt();
      renderHook(use);
      const claims = vi.mocked(toast.error).mock.calls.map(([msg]) => String(msg));
      expect(
        claims.filter((m) => /fail|revert|reject/i.test(m)),
        'the hook claimed the transaction failed, but all that failed was our read of ' +
          'the receipt. That claim is an instruction to resend, and a resend pays twice.',
      ).toEqual([]);
    });

    it(name + ': an unreadable receipt says we cannot tell, with somewhere to check', () => {
      landUnreadableReceipt();
      renderHook(use);
      const calls = vi.mocked(toast.warning).mock.calls;
      expect(calls.length, 'the hook said nothing at all about a terminal transaction').toBeGreaterThan(0);
      const [title, opts] = calls[0] as [string, Record<string, unknown> | undefined];
      expect(title).toMatch(/(couldn.?t|could not|cannot|unable to) confirm/i);
      const description = String(opts?.description ?? '');
      expect(description, 'no description - "we could not confirm it" alone is a dead end').not.toBe('');
      expect(
        description,
        'the copy does not say the outcome is unknown, so it still reads as a verdict',
      ).toMatch(/can.?t tell whether it went through/i);
      expect(
        description,
        'the copy claims the transaction may have SUCCEEDED - false for a revert whose receipt read also failed',
      ).not.toMatch(/succeeded/i);
      expect(
        description,
        'the copy does not warn the user to check before resending - the entire point of this branch',
      ).toMatch(/before you send it again/i);
      expect(description, 'the copy does not name WHICH transaction to check').toMatch(/0x[0-9a-fA-F]{6,}/);
      expect(opts?.action, 'no explorer action - nowhere for the user to go and read it themselves').toBeTruthy();
    });

    it(name + ': an unreadable receipt is not a success either', () => {
      landUnreadableReceipt();
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(false);
      expect(toast.success).not.toHaveBeenCalled();
    });
  }

  // THE DEAD SWAP BUTTON. `isPendingRef` is a ref, so a latch left set re-renders
  // nothing: the button stays enabled and every click returns at executeSwap's first
  // line. Pinned by behaviour — a second executeSwap must reach writeContract.
  for (const [label, land] of [
    ['an unreadable receipt', landUnreadableReceipt],
    ['a thrown revert', () => landRevert('thrown')],
  ] as const) {
    it(`useSwap: after ${label}, the next swap is actually sent`, () => {
      const { result, rerender } = renderHook(() => useSwap());
      act(() => result.current.setInputAmount('0.01'));
      act(() => result.current.executeSwap());
      expect(wagmiState.writeContractMock, 'the first swap never reached writeContract').toHaveBeenCalledTimes(1);

      land();
      rerender();
      act(() => result.current.executeSwap());
      expect(
        wagmiState.writeContractMock,
        'the second swap was swallowed: the in-flight latch was never released',
      ).toHaveBeenCalledTimes(2);
    });
  }

  it('useSwap: an unreadable receipt is an error state for the page', () => {
    landUnreadableReceipt();
    const swap = renderHook(() => useSwap());
    expect(swap.result.current.isTxError).toBe(true);
  });
});

/**
 * A RECEIPT IS ONLY PROOF OF ITS OWN TRANSACTION.
 *
 * When the wallet replaces a pending transaction at the same nonce, viem's waiter
 * does not fail. It resolves with the REPLACEMENT's receipt, whatever the reason
 * (measured against the real library in lib/txErrors.receipt.test.ts). A wallet
 * "cancel" is a 0-value send to yourself, so its receipt says success, and every
 * hook here reported the stake, swap or claim it replaced as confirmed.
 *
 *   cancelled / replaced   =>  hook.isSuccess === false, no success toast, no analytics
 *                          /\  a warning that it was cancelled or replaced and did not happen
 *                          /\  the in-flight latch is released
 *   repriced (a speed-up)  =>  still a success: the same call ran, under a new hash
 *   reason never recorded  =>  not a success, and no verdict either way
 */
const REPLACEMENT_HASH = '0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed' as `0x${string}`;

/**
 * The submitted hash was replaced by REPLACEMENT_HASH, whose receipt says success.
 * Every call submits a fresh hash: viem's reason is recorded per submitted hash,
 * and one case's record must not answer for the next.
 */
let submittedSeq = 0;
function landReplacement(reason: 'cancelled' | 'replaced' | 'repriced', opts: { silent?: boolean } = {}) {
  landReceipt('success');
  submittedSeq += 1;
  wagmiState.hash = `0x${submittedSeq.toString(16).padStart(64, 'c')}` as `0x${string}`;
  wagmiState.replacement = { hash: REPLACEMENT_HASH, reason, silent: opts.silent };
}

describe('a cancelled or replaced transaction must not render as success', () => {
  beforeEach(resetMocks);

  for (const reason of ['cancelled', 'replaced'] as const) {
    for (const { name, use } of ALL_HOOKS) {
      it(`${name}: a ${reason} tx is not a success`, () => {
        landReplacement(reason);
        const { result } = renderHook(use);
        expect(result.current.isSuccess, `a ${reason} tx reported success off the replacement's receipt`).toBe(false);
        expect(toast.success).not.toHaveBeenCalled();
      });

      it(`${name}: a ${reason} tx says so, and that what was sent did not happen`, () => {
        landReplacement(reason);
        renderHook(use);
        const calls = vi.mocked(toast.warning).mock.calls;
        expect(calls.length, 'the hook said nothing at all about a terminal transaction').toBeGreaterThan(0);
        const [title, opts] = calls[0] as [string, Record<string, unknown> | undefined];
        expect(title).toMatch(reason === 'cancelled' ? /cancel/i : /replac/i);
        const description = String(opts?.description ?? '');
        expect(description).toMatch(/did not happen/i);
        expect(description, 'the copy does not name the tx that confirmed instead').toMatch(/0x5eed5eed/);
        expect(opts?.action, 'no explorer action').toBeTruthy();
        // Not a revert and not a failure: what was sent never ran at all.
        const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
        expect(errors.filter((m) => /fail|revert/i.test(m))).toEqual([]);
      });
    }
  }

  for (const { name, use } of ALL_HOOKS) {
    it(`${name}: another tx's receipt with no recorded reason is not a success, and says check first`, () => {
      landReplacement('cancelled', { silent: true });
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(false);
      expect(toast.success).not.toHaveBeenCalled();
      const [, opts] = (vi.mocked(toast.warning).mock.calls[0] ?? []) as [string, Record<string, unknown> | undefined];
      expect(String(opts?.description ?? '')).toMatch(/before you send it again/i);
    });
  }

  it('useSwap: a cancelled swap is not sent to analytics', () => {
    landReplacement('cancelled');
    renderHook(() => useSwap());
    expect(trackSwap).not.toHaveBeenCalled();
  });

  it('useFarmActions: a cancelled stake is not sent to analytics', () => {
    const { result, rerender } = renderHook(() => useFarmActions());
    act(() => result.current.stake('10', 86400n));
    landReplacement('cancelled');
    rerender();
    expect(trackStake).not.toHaveBeenCalled();
  });

  it('useSwap: after a cancelled swap, the next swap is actually sent', () => {
    const { result, rerender } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('0.01'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).toHaveBeenCalledTimes(1);
    landReplacement('cancelled');
    rerender();
    act(() => result.current.executeSwap());
    expect(
      wagmiState.writeContractMock,
      'the second swap was swallowed: the in-flight latch was never released',
    ).toHaveBeenCalledTimes(2);
  });
});

describe('a sped-up transaction is still a success', () => {
  beforeEach(resetMocks);

  // The control, and the reason the check cannot be a bare hash comparison: a
  // speed-up resolves exactly like a cancel (another hash, a success receipt).
  // Calling it "did not happen" tells the user to send the swap again, and the
  // second one pays twice. This also fails any hook that does not pass
  // `onReplaced`, because then the reason is never known.
  for (const { name, use } of HOOKS) {
    it(`${name}: a repriced tx reports success`, () => {
      landReplacement('repriced');
      const { result } = renderHook(use);
      expect(result.current.isSuccess).toBe(true);
      expect(toast.success).toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });
  }
  for (const { name, use } of ALL_HOOKS) {
    it(`${name}: a repriced tx is not called cancelled, replaced or unconfirmed`, () => {
      landReplacement('repriced');
      renderHook(use);
      expect(vi.mocked(toast.warning).mock.calls.map(([m]) => String(m))).toEqual([]);
    });
  }
});
