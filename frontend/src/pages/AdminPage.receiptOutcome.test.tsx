/**
 * The admin pause control reports a revert as a revert and an unreadable receipt
 * as "we can't tell".
 *
 * wagmi's waitForTransactionReceipt THROWS on a reverted receipt (lib/txErrors.ts),
 * so a reverted pause/unpause reached PauseControls on `isError`, which it never
 * read: its revert toast was dead, and an owner who paused during an incident was
 * told nothing either way. Same harness as AdminPage.authz.test.tsx, owner wallet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError, type Address } from 'viem';
import { toast } from 'sonner';

const OWNER = '0x14898258122c0740106391e6e8e4f17F3b6D456E' as Address;
const HASH = `0x${'cd'.repeat(32)}` as const;

const state = vi.hoisted(() => ({ receiptError: undefined as unknown }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: OWNER, isConnected: true }),
  useChainId: () => 1,
  useChains: () => [{ id: 1, name: 'Ethereum', blockExplorers: { default: { url: 'https://etherscan.io' } } }],
  useReadContract: () => ({ data: OWNER, isLoading: false, refetch: vi.fn() }),
  useReadContracts: () => ({ data: [], error: null, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: HASH, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: false,
    isError: state.receiptError !== undefined,
    error: state.receiptError ?? null,
    data: undefined,
  }),
}));

vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/launcher/IntegratorFeesPanel', () => ({ IntegratorFeesPanel: () => null }));

import AdminPage from './AdminPage';

beforeEach(() => {
  vi.clearAllMocks();
  state.receiptError = undefined;
});

describe('AdminPage pause control receipt', () => {
  it('a revert wagmi THREW says the pause reverted', () => {
    state.receiptError = new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {});
    render(<AdminPage />);
    const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
    expect(errors.some((m) => /Pause transaction reverted on-chain/.test(m)), JSON.stringify(errors)).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('an unreadable receipt says we cannot tell, and is never called reverted', () => {
    state.receiptError = new TransactionReceiptNotFoundError({ hash: HASH });
    render(<AdminPage />);
    expect(toast.warning).toHaveBeenCalled();
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, { description: string }];
    expect(title).toMatch(/couldn.?t confirm/i);
    expect(opts.description).toMatch(/can.?t tell whether it went through/i);
    expect(opts.description).toMatch(/already in the state you asked for/);
    expect(vi.mocked(toast.error).mock.calls.map(([m]) => String(m)).filter((m) => /revert|fail/i.test(m))).toEqual([]);
  });
});
