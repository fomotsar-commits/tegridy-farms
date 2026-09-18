/**
 * A pool owner's liquidity deposit or withdrawal says it happened when the
 * receipt says so, not when the wallet hands back a hash.
 *
 * PoolCard toasted "Liquidity added!" / "Liquidity withdrawn!" from
 * writeContract's per-call `onSuccess`, which fires on SUBMISSION, and in the
 * same breath cleared the inputs and folded the panel away. Its own receipt
 * comment admitted it: "the submission callback below already toasted".
 * BuySellPanel in the same file already did it right (info on submit, success
 * from the receipt); the card now does the same, once per hash.
 *
 * The shared wagmi mock hands back fresh `refetch` fns on every render, and the
 * card's refetch effect lists them, so a toast placed in that effect would fire
 * on every re-render. The confirmed-path tests re-render, then count.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
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

import { AMMSection } from './AMMSection';

type Hash = `0x${string}`;
const OWNER = '0x1111111111111111111111111111111111111111' as const;
const POOL = '0x3333333333333333333333333333333333333333' as const;
const COLLECTION = '0x2222222222222222222222222222222222222222' as const;
const HASH_A: Hash = `0x${'aa'.repeat(32)}`;
const HASH_B: Hash = `0x${'bb'.repeat(32)}`;

/** The owner's own tracked pool, open on its Manage Liquidity panel. */
function openManageLiquidity() {
  localStorage.setItem('tegridy-amm-tracked-pools', JSON.stringify([POOL]));
  const view = renderWithProviders(<AMMSection />);
  fireEvent.click(screen.getByRole('tab', { name: 'My Pools' }));
  fireEvent.click(screen.getByText('Manage Liquidity'));
  return { rerender: () => view.rerender(<AMMSection />) };
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
const ethField = () => screen.queryAllByPlaceholderText('0.0')[0] as HTMLInputElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: OWNER, isConnected: true });
  // [collection, poolType, spot, delta, feeBps, protocolFeeBps, owner, numNFTs, ethBalance]
  wagmiMock.setReadResult({
    functionName: 'getPoolInfo',
    result: [COLLECTION, 2, parseEther('1'), parseEther('0.1'), 0n, 0n, OWNER, 0n, parseEther('2')],
  });
  wagmiMock.setReadResult({ functionName: 'getHeldTokenIds', result: [] });
});

describe('PoolCard: a submitted liquidity move is not a confirmed one', () => {
  it('says the deposit was submitted, claims nothing, and keeps the panel and its amount', () => {
    const { rerender } = openManageLiquidity();
    fireEvent.change(ethField()!, { target: { value: '0.5' } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByRole('button', { name: 'Deposit Liquidity' }));
    rerender();

    expect(toast.info).toHaveBeenCalledWith('Deposit submitted — confirming on-chain…');
    expect(toast.success).not.toHaveBeenCalled();
    expect(ethField()?.value).toBe('0.5');
  });

  it('says liquidity was added once the receipt confirms, once per hash, then folds the panel', () => {
    const { rerender } = openManageLiquidity();
    fireEvent.change(ethField()!, { target: { value: '0.5' } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByRole('button', { name: 'Deposit Liquidity' }));
    rerender();
    expect(toast.success).not.toHaveBeenCalled();

    receiptLands(HASH_A, 'success');
    rerender();
    rerender();
    rerender();
    expect(successes('Liquidity added!')).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(ethField()).toBeUndefined();
  });

  it('says a withdrawal was submitted, then withdrawn once its own receipt confirms', () => {
    const { rerender } = openManageLiquidity();
    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    fireEvent.change(ethField()!, { target: { value: '1' } });
    walletReturns(HASH_B);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw Liquidity' }));
    rerender();

    expect(toast.info).toHaveBeenCalledWith('Withdrawal submitted — confirming on-chain…');
    expect(toast.success).not.toHaveBeenCalled();
    expect(ethField()?.value).toBe('1');

    receiptLands(HASH_B, 'success');
    rerender();
    rerender();
    expect(successes('Liquidity withdrawn!')).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('does not say it again when the same receipt is re-read', () => {
    const { rerender } = openManageLiquidity();
    fireEvent.change(ethField()!, { target: { value: '0.5' } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByRole('button', { name: 'Deposit Liquidity' }));
    receiptLands(HASH_A, 'success');
    rerender();
    expect(successes('Liquidity added!')).toBe(1);

    // A re-read of the same receipt (a refetch on window focus) fails once, then lands again.
    wagmiMock.setWriteStatus({ isSuccess: false, isTxError: true });
    rerender();
    wagmiMock.setWriteStatus({ isSuccess: true, isTxError: false });
    rerender();
    expect(successes('Liquidity added!')).toBe(1);
  });

  it('never says liquidity moved for a reverted receipt, and leaves the amount to retry with', () => {
    const { rerender } = openManageLiquidity();
    fireEvent.change(ethField()!, { target: { value: '0.5' } });
    walletReturns(HASH_A);
    fireEvent.click(screen.getByRole('button', { name: 'Deposit Liquidity' }));
    rerender();
    receiptLands(HASH_A, 'reverted');
    rerender();
    rerender();

    expect(toast.success).not.toHaveBeenCalled();
    expect(ethField()?.value).toBe('0.5');
  });
});
