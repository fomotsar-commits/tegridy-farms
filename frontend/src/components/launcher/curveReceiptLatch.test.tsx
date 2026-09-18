/**
 * The curve's two receipt latches release on a revert and on an unreadable
 * receipt, not only on a success.
 *
 * CurveTradePanel (`tx`) and CurveCreatorClaim (`txHash`) hold their button on
 * "Confirming on-chain…" from submission until the receipt, and cleared that
 * state only when `isSuccess` came back with a receipt. wagmi THROWS on a
 * reverted receipt (lib/txErrors.ts), so a real revert arrived on `isError`,
 * the latch never released, the promised red revert toast never fired, and the
 * panel stayed dead until a reload. The same was true of a receipt that could
 * not be read. These tests drive the real containers through a submit and hand
 * back the real viem error types.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError, parseEther } from 'viem';
import { toast } from 'sonner';

const USER = '0x1111111111111111111111111111111111111111' as const;
const LAUNCHER = '0x3333333333333333333333333333333333333333' as const;
const TOKEN = '0x4444444444444444444444444444444444444444' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;

const w = vi.hoisted(() => ({
  /** What the receipt wait reports once a hash is being watched. */
  receipt: { isSuccess: false, isError: false, error: null as unknown, data: undefined as unknown },
  reads: {} as Record<string, unknown>,
}));

vi.mock('wagmi', async () => {
  const { vi: v } = await import('vitest');
  return {
    useAccount: () => ({ address: USER }),
    useWriteContract: () => ({
      // The wallet signs at once: onSuccess(hash) is "submitted", not "confirmed".
      writeContract: (_cfg: unknown, opts?: { onSuccess?: (h: string) => void }) => opts?.onSuccess?.(HASH),
      isPending: false,
    }),
    useReadContract: ({ functionName }: { functionName: string }) => ({
      data: w.reads[functionName],
      isError: false,
      refetch: v.fn(),
    }),
    useWaitForTransactionReceipt: ({ hash, query }: { hash?: string; query?: { enabled?: boolean } }) =>
      hash && query?.enabled !== false
        ? w.receipt
        : { isSuccess: false, isError: false, error: null, data: undefined },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../hooks/useCurveIdentity', () => ({ useCurveIdentity: () => ({ status: 'resolving' }) }));

vi.mock('framer-motion', () => {
  const Div = ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>;
  const passthrough = new Proxy({}, { get: () => Div });
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { CurveTradePanel } from './CurveTradePanel';
import { CurveCreatorClaim } from '../../pages/CurveTokenPage';

const revert = () => new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {});
const unread = () => new TransactionReceiptNotFoundError({ hash: HASH });

// At its raise target and not yet graduated: the one state with a single
// no-input button (Finalize graduation) that goes through the receipt latch.
const DEFERRED_LAUNCH = {
  creator: USER,
  virtualEth: parseEther('0.2'),
  graduationEth: parseEther('3.8'),
  feeBps: 100,
  creatorFeeShareBps: 4000,
  treasuryFeeShareBps: 2500,
  reserveRecipient: USER,
  saleSupply: 10n ** 27n,
  reserveAmount: 0n,
  ethReserve: parseEther('3.8'),
  tokenReserve: 10n ** 26n,
  graduated: false,
};

beforeEach(() => {
  w.receipt = { isSuccess: false, isError: false, error: null, data: undefined };
  w.reads = {};
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.success).mockClear();
});

const failWith = (error: unknown) => {
  w.receipt = { isSuccess: false, isError: true, error, data: undefined };
};

describe('CurveTradePanel releases its latch when the receipt wait fails', () => {
  const panel = () =>
    render(
      <MemoryRouter>
        <CurveTradePanel launcher={LAUNCHER} token={TOKEN} chainId={1} />
      </MemoryRouter>,
    );
  const finalize = () => screen.getByRole('button', { name: /finalize graduation|confirming on-chain/i });

  beforeEach(() => {
    w.reads = { getLaunch: DEFERRED_LAUNCH };
  });

  it('a thrown revert says reverted and gives the button back', () => {
    failWith(revert());
    panel();
    fireEvent.click(finalize());

    expect(finalize()).toHaveTextContent('Finalize graduation');
    expect(finalize()).toBeEnabled();
    const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
    expect(errors.some((m) => /Finalize graduation failed on-chain \(reverted\)/.test(m)), JSON.stringify(errors)).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('an unreadable receipt says we cannot tell (never reverted), and gives the button back', () => {
    failWith(unread());
    panel();
    fireEvent.click(finalize());

    expect(finalize()).toHaveTextContent('Finalize graduation');
    expect(finalize()).toBeEnabled();
    expect(toast.warning).toHaveBeenCalled();
    const [, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, { description: string }];
    expect(opts.description).toMatch(/can.?t tell whether it went through/i);
    expect(opts.description).toMatch(/second finalize reverts/i);
    expect(vi.mocked(toast.error).mock.calls.map(([m]) => String(m)).filter((m) => /revert|fail/i.test(m))).toEqual([]);
  });
});

describe('CurveCreatorClaim releases its latch when the receipt wait fails', () => {
  const claim = () =>
    render(<CurveCreatorClaim launcher={LAUNCHER} chainId={1} token={TOKEN} creator={USER} />);
  const button = () => screen.getByRole('button', { name: /^claim$|confirming on-chain/i });

  beforeEach(() => {
    w.reads = { creatorFeeOf: parseEther('0.5') };
  });

  it('a thrown revert says reverted and gives Claim back', () => {
    failWith(revert());
    claim();
    fireEvent.click(button());

    expect(button()).toHaveTextContent(/^Claim$/);
    expect(button()).toBeEnabled();
    const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
    expect(errors.some((m) => /Claim failed on-chain \(reverted\)/.test(m)), JSON.stringify(errors)).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('an unreadable receipt says we cannot tell (never reverted), and gives Claim back', () => {
    failWith(unread());
    claim();
    fireEvent.click(button());

    expect(button()).toHaveTextContent(/^Claim$/);
    expect(button()).toBeEnabled();
    expect(toast.warning).toHaveBeenCalled();
    const [, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, { description: string }];
    expect(opts.description).toMatch(/can.?t tell whether it went through/i);
    expect(vi.mocked(toast.error).mock.calls.map(([m]) => String(m)).filter((m) => /revert|fail/i.test(m))).toEqual([]);
  });
});
