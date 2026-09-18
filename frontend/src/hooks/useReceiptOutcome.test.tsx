/**
 * useReceiptOutcome: receiptOutcome() plus the "we can't tell" warning an
 * unreadable receipt is owed, and nothing else.
 *
 * The errors are the real viem types wagmi throws (measurement table in
 * lib/txErrors.ts): a revert is a CallExecutionError from wagmi's replay, and an
 * unreadable receipt is a viem read error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError } from 'viem';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useReceiptOutcome } from './useReceiptOutcome';

const HASH = '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' as const;
const REPEAT = 'a second one does the thing twice.';
const revert = () => new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {});
const unread = () => new TransactionReceiptNotFoundError({ hash: HASH });

const run = (q: Parameters<typeof useReceiptOutcome>[0], opts: { hash: `0x${string}` | undefined } = { hash: HASH }) =>
  renderHook(() => useReceiptOutcome(q, { hash: opts.hash, chainId: 1, repeatCost: REPEAT })).result.current;

beforeEach(() => {
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('useReceiptOutcome', () => {
  it('a thrown revert is a revert, and draws no "can\'t tell" warning', () => {
    const o = run({ isSuccess: false, isError: true, error: revert() });
    expect(o).toEqual({ isSuccess: false, isReverted: true, isReceiptUnreadable: false });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('an unreadable receipt is neither success nor revert, and says so with the hash and the resend cost', () => {
    const o = run({ isSuccess: false, isError: true, error: unread() });
    expect(o).toEqual({ isSuccess: false, isReverted: false, isReceiptUnreadable: true });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toMatch(/couldn.?t confirm/i);
    expect(String(opts.description)).toMatch(/can.?t tell whether it went through/i);
    expect(String(opts.description)).toContain(REPEAT);
    expect(String(opts.description)).toMatch(/0xfeedfeed/);
    expect(opts.id).toBe(`unconfirmed-${HASH}`);
    // Never an error toast: nothing is known to have gone wrong.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a successful receipt is a success and says nothing', () => {
    const o = run({ isSuccess: true, isError: false, data: { status: 'success' } });
    expect(o).toEqual({ isSuccess: true, isReverted: false, isReceiptUnreadable: false });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('says nothing without a hash to point at', () => {
    run({ isSuccess: false, isError: true, error: unread() }, { hash: undefined });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
