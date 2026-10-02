/**
 * An owner action says it succeeded when its receipt says so, not when the
 * wallet hands back a hash.
 *
 * wagmi's per-call `onSuccess` fires on SUBMISSION. `exec` toasted
 * "<fn> succeeded" there and cleared the field the operator had typed, so a
 * write still waiting to be mined, or one that went on to revert, read as
 * applied, and the typed URI or root was gone before anyone knew. The submit
 * now says "submitted — confirming on-chain…"; "<fn> succeeded" and the field
 * reset wait for a confirmed receipt, once per hash.
 *
 * The shared wagmi mock hands back fresh `refetch` fns on every render, so an
 * effect that listed them would toast on every re-render. The confirmed-path
 * tests re-render several times after the receipt lands, then count.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('framer-motion', () => {
  const Div = ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>;
  const passthrough = new Proxy({}, { get: () => Div });
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { OwnerAdminPanelV2 } from './OwnerAdminPanelV2';

type Hash = `0x${string}`;
const DROP = '0x1234567890123456789012345678901234567890';
const HASH_A: Hash = `0x${'aa'.repeat(32)}`;
const HASH_B: Hash = `0x${'bb'.repeat(32)}`;
const URI = 'ar://collection/contract.json';
const PLACEHOLDER = 'ar://collection/placeholder';

function mount() {
  const view = renderWithProviders(<OwnerAdminPanelV2 dropAddress={DROP} deployed />);
  fireEvent.click(screen.getByText('Owner Admin (V2)'));
  return { rerender: () => view.rerender(<OwnerAdminPanelV2 dropAddress={DROP} deployed />) };
}

/** The wallet signs and hands back `hash`: all wagmi's per-call onSuccess means. */
function walletReturns(hash: Hash) {
  wagmiMock.writeContract().mockImplementationOnce((_req: unknown, opts?: { onSuccess?: (h: Hash) => void }) => {
    wagmiMock.setWriteStatus({ hash, isConfirming: true, isSuccess: false });
    opts?.onSuccess?.(hash);
  });
}

function receiptLands(hash: Hash, receiptStatus: 'success' | 'reverted') {
  wagmiMock.setWriteStatus({ hash, isConfirming: false, isSuccess: true, receiptStatus });
}

const successes = (message: string) => vi.mocked(toast.success).mock.calls.filter(([m]) => m === message).length;
const contractUriField = () => screen.getByPlaceholderText('ar://…/contract.json') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  wagmiMock.reset();
  wagmiMock.setReadResult({ functionName: 'mintPhase', result: 2n });
  wagmiMock.setReadResult({ functionName: 'paused', result: false });
  wagmiMock.setReadResult({ functionName: 'totalSupply', result: 10n });
  wagmiMock.setReadResult({ functionName: 'maxSupply', result: 100n });
});

describe('OwnerAdminPanelV2: a submitted write is not a confirmed one', () => {
  it('says submitted on the hash, claims nothing, and keeps what the operator typed', () => {
    const { rerender } = mount();
    fireEvent.change(contractUriField(), { target: { value: URI } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByText('Update contractURI'));
    rerender();

    expect(toast.info).toHaveBeenCalledWith('setContractURI submitted — confirming on-chain…');
    expect(toast.success).not.toHaveBeenCalled();
    expect(contractUriField().value).toBe(URI);
  });

  it('says succeeded once the receipt confirms, once per hash, and only then clears the field', () => {
    const { rerender } = mount();
    fireEvent.change(contractUriField(), { target: { value: URI } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByText('Update contractURI'));
    rerender();
    expect(toast.success).not.toHaveBeenCalled();

    receiptLands(HASH_A, 'success');
    rerender();
    rerender();
    rerender();
    expect(successes('setContractURI succeeded')).toBe(1);
    expect(contractUriField().value).toBe('');

    // A second write gets its own confirmation, named for what it did.
    fireEvent.change(screen.getByPlaceholderText('ar://…/placeholder'), { target: { value: PLACEHOLDER } });
    walletReturns(HASH_B);
    fireEvent.click(screen.getByText('Set Placeholder'));
    rerender();
    expect(successes('setBaseURI succeeded')).toBe(0);
    receiptLands(HASH_B, 'success');
    rerender();
    rerender();
    expect(successes('setBaseURI succeeded')).toBe(1);
    expect(successes('setContractURI succeeded')).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it('does not say it again when the same receipt is re-read', () => {
    const { rerender } = mount();
    fireEvent.change(contractUriField(), { target: { value: URI } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByText('Update contractURI'));
    receiptLands(HASH_A, 'success');
    rerender();
    expect(successes('setContractURI succeeded')).toBe(1);

    // A re-read of the same receipt (a refetch on window focus) fails once, then lands again.
    wagmiMock.setWriteStatus({ isSuccess: false, isTxError: true });
    rerender();
    wagmiMock.setWriteStatus({ isSuccess: true, isTxError: false });
    rerender();
    expect(successes('setContractURI succeeded')).toBe(1);
  });

  it('never says succeeded for a reverted receipt, and leaves the typed value to retry with', () => {
    const { rerender } = mount();
    fireEvent.change(contractUriField(), { target: { value: URI } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByText('Update contractURI'));
    rerender();
    receiptLands(HASH_A, 'reverted');
    rerender();
    rerender();

    expect(toast.success).not.toHaveBeenCalled();
    expect(contractUriField().value).toBe(URI);
  });
});
