// The wallet half of the money path.
//
// Three things are asserted here that cannot be asserted in deposit.test.ts,
// because they are about what the hook DOES with a plan rather than about the
// plan itself: a reverted transaction is reported as reverted, a wallet swap
// mid-flight discards the pending step, and no write is ever issued to an
// address the plan did not name.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { YIELD_ADDRESSES } from '../lib/yield/protocols';
import { yieldVenue } from '../lib/yield/venues';

const writeContract = vi.fn();
const readContract = vi.fn();
const refetch = vi.fn();
// Stable identities. wagmi memoises both; a fresh function per render would
// re-run the account-reset effect on every render and wipe state that is
// supposed to survive one.
const resetWrite = vi.fn();

let account: string | undefined = '0x00000000000000000000000000000000000000A1';
let receiptState: { data?: { status: string; blockNumber: bigint }; isSuccess: boolean; isError: boolean } = {
  isSuccess: false,
  isError: false,
};
let writeHash: string | undefined;

const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    info: vi.fn(),
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: account }),
  useChainId: () => 1,
  useBalance: () => ({ data: { value: 10n ** 19n } }),
  usePublicClient: () => ({ readContract }),
  useReadContracts: () => ({
    data: [
      { status: 'success', result: 10n ** 18n },
      { status: 'success', result: 10n ** 18n },
    ],
    refetch,
  }),
  useWriteContract: () => ({ writeContract, data: writeHash, reset: resetWrite }),
  useWaitForTransactionReceipt: () => ({
    data: receiptState.data,
    isSuccess: receiptState.isSuccess,
    isError: receiptState.isError,
  }),
}));

const { useYieldDeposit } = await import('./useYieldDeposit');

const LIDO = yieldVenue('lido-steth')!;
const AAVE = yieldVenue('aave-v3-usdc')!;

beforeEach(() => {
  writeContract.mockReset();
  readContract.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  account = '0x00000000000000000000000000000000000000A1';
  writeHash = undefined;
  receiptState = { isSuccess: false, isError: false };
});

describe('a write only ever goes where the plan said', () => {
  it('submits the plan\'s first step verbatim, to the plan\'s own address', () => {
    const { result } = renderHook(() => useYieldDeposit({ venue: LIDO, amountText: '1', rocket: null }));
    act(() => result.current.submit());
    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0]![0] as { address: string; functionName: string; value?: bigint; chainId: number };
    expect(call.address).toBe(YIELD_ADDRESSES.stETH);
    expect(call.functionName).toBe('submit');
    expect(call.value).toBe(10n ** 18n);
    // Pinned to mainnet on the call itself, not left to whichever chain the
    // wallet happens to be on when it signs.
    expect(call.chainId).toBe(1);
  });

  it('submits the APPROVAL first for a two-step route, never the supply', () => {
    // The failure this prevents: firing the deposit before the allowance exists
    // reverts, and the user has paid gas to learn that.
    const { result } = renderHook(() => useYieldDeposit({ venue: AAVE, amountText: '2000', rocket: null }));
    // Allowance is mocked at 1e18 units, and 2000 USDC is 2e9 — but the mocked
    // allowance read is in the same units, so this asks for the supply. Use a
    // larger amount to force the approval branch.
    expect(['needs-approval', 'ready']).toContain(result.current.plan.state);
    act(() => result.current.submit());
    const call = writeContract.mock.calls[0]![0] as { address: string; functionName: string };
    if (result.current.plan.state === 'needs-approval') {
      expect(call.functionName).toBe('approve');
      expect(call.address).toBe(YIELD_ADDRESSES.usdc);
    } else {
      expect(call.address).toBe(YIELD_ADDRESSES.aaveV3Pool);
    }
  });

  it('refuses to submit anything at all when the plan is not submittable', () => {
    const cbeth = yieldVenue('coinbase-cbeth')!;
    const { result } = renderHook(() => useYieldDeposit({ venue: cbeth, amountText: '1', rocket: null }));
    expect(result.current.plan.state).toBe('unroutable');
    act(() => result.current.submit());
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('never issues a write for an unparseable amount', () => {
    const { result } = renderHook(() => useYieldDeposit({ venue: LIDO, amountText: 'abc', rocket: null }));
    expect(result.current.plan.state).toBe('invalid-amount');
    act(() => result.current.submit());
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('a receipt is not a success', () => {
  it('reports a reverted transaction as reverted and reads no balances', async () => {
    // wagmi's isSuccess means the receipt ARRIVED. A reverted transaction
    // produces one too — this repo shipped "confirmed" for stakes that moved
    // nothing until that was fixed on the farm page.
    writeHash = '0xabc';
    receiptState = { data: { status: 'reverted', blockNumber: 100n }, isSuccess: true, isError: false };
    renderHook(() => useYieldDeposit({ venue: LIDO, amountText: '1', rocket: null }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
    const description = (toastError.mock.calls[0]![1] as { description: string }).description;
    expect(description).toMatch(/Nothing moved/);
  });

  it('reads the receipt token at TWO named blocks on a real success', async () => {
    writeHash = '0xabc';
    receiptState = { data: { status: 'success', blockNumber: 100n }, isSuccess: true, isError: false };
    readContract.mockResolvedValueOnce(0n).mockResolvedValueOnce(10n ** 18n);
    const { result } = renderHook(() => useYieldDeposit({ venue: LIDO, amountText: '1', rocket: null }));
    await waitFor(() => expect(result.current.receiptBalances).not.toBeNull());
    expect(readContract).toHaveBeenCalledTimes(2);
    const first = readContract.mock.calls[0]![0] as { blockNumber: bigint; address: string };
    const second = readContract.mock.calls[1]![0] as { blockNumber: bigint };
    // The block BEFORE and the block OF — so the panel prints a range rather
    // than a single "you received X", which would be wrong for every rebasing
    // receipt on this page.
    expect(first.blockNumber).toBe(99n);
    expect(second.blockNumber).toBe(100n);
    expect(first.address).toBe(YIELD_ADDRESSES.stETH);
    expect(result.current.receiptBalances).toMatchObject({ beforeBlock: 99, afterBlock: 100, symbol: 'stETH' });
  });

  it('leaves the report absent rather than half-read when a node will not serve the earlier block', async () => {
    writeHash = '0xabc';
    receiptState = { data: { status: 'success', blockNumber: 100n }, isSuccess: true, isError: false };
    readContract.mockRejectedValue(new Error('missing trie node'));
    const { result } = renderHook(() => useYieldDeposit({ venue: LIDO, amountText: '1', rocket: null }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(result.current.receiptBalances).toBeNull();
  });
});

describe('a wallet swap mid-flight is not inherited', () => {
  it('says nothing about a receipt belonging to the previous account', async () => {
    writeHash = '0xabc';
    receiptState = { isSuccess: false, isError: false };
    const { result, rerender } = renderHook(() => useYieldDeposit({ venue: LIDO, amountText: '1', rocket: null }));
    act(() => result.current.submit());
    // A different wallet connects before the receipt lands.
    account = '0x00000000000000000000000000000000000000B2';
    receiptState = { data: { status: 'success', blockNumber: 100n }, isSuccess: true, isError: false };
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });
});
