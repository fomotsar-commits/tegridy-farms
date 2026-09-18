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
import { noteReplacement } from '../lib/txErrors';

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
    expect(o).toEqual({ isSuccess: false, isReverted: true, isReceiptUnreadable: false, isReplaced: false, replacement: null });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('an unreadable receipt is neither success nor revert, and says so with the hash and the resend cost', () => {
    const o = run({ isSuccess: false, isError: true, error: unread() });
    expect(o).toEqual({ isSuccess: false, isReverted: false, isReceiptUnreadable: true, isReplaced: false, replacement: null });
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
    const o = run({ isSuccess: true, isError: false, data: { status: 'success', transactionHash: HASH } });
    expect(o).toEqual({ isSuccess: true, isReverted: false, isReceiptUnreadable: false, isReplaced: false, replacement: null });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('says nothing without a hash to point at', () => {
    run({ isSuccess: false, isError: true, error: unread() }, { hash: undefined });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

// viem resolves a replaced wait with the REPLACEMENT's receipt (measured in
// lib/txErrors.receipt.test.ts). Each case submits its own hash, because viem's
// reason is recorded per submitted hash.
describe('useReceiptOutcome: a receipt that is not the submitted transaction', () => {
  const OTHER = '0x0dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd0' as const;
  const submitted = (n: number) => `0x${n.toString(16).padStart(64, 'e')}` as `0x${string}`;
  const landed = { isSuccess: true, isError: false, data: { status: 'success', transactionHash: OTHER } };

  it('a cancel is not a success, and says what was sent did not happen', () => {
    const hash = submitted(1);
    noteReplacement({ reason: 'cancelled', replacedTransaction: { hash } });
    const o = run(landed, { hash });
    expect(o).toEqual({
      isSuccess: false, isReverted: false, isReceiptUnreadable: false,
      isReplaced: true, replacement: { hash: OTHER, reason: 'cancelled' },
    });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toMatch(/cancel/i);
    expect(String(opts.description)).toMatch(/did not happen/i);
    expect(String(opts.description)).toMatch(/0x0dd00dd0/);
    expect(opts.id).toBe(`replaced-${hash}`);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a speed-up is a success and says nothing: the same call ran', () => {
    const hash = submitted(2);
    noteReplacement({ reason: 'repriced', replacedTransaction: { hash } });
    const o = run(landed, { hash });
    expect(o.isSuccess).toBe(true);
    expect(o.isReplaced).toBe(false);
    expect(o.replacement).toEqual({ hash: OTHER, reason: 'repriced' });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('with no recorded reason it is not a success, and makes no claim either way', () => {
    const o = run(landed, { hash: submitted(3) });
    expect(o.isSuccess).toBe(false);
    expect(o.isReplaced).toBe(true);
    const [, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, Record<string, unknown>];
    expect(String(opts.description)).toMatch(/before you send it again/i);
    expect(String(opts.description)).not.toMatch(/did not happen/i);
  });

  it('matches the submitted hash regardless of case', () => {
    const o = run(
      { isSuccess: true, isError: false, data: { status: 'success', transactionHash: HASH.toUpperCase().replace('0X', '0x') } },
      { hash: HASH },
    );
    expect(o.isSuccess).toBe(true);
    expect(o.replacement).toBeNull();
  });
});
