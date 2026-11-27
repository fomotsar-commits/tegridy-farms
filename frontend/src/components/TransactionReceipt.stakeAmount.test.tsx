// A stake or lock receipt's Amount is what the visitor still holds in the stake, so it is cut at the
// digits shown, as every other stake figure is: never printed above the amount staked.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TransactionReceiptProvider } from './TransactionReceipt';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';

const HASH = `0x${'ab'.repeat(32)}` as const;

function Opener({ type }: { type: 'stake' | 'lock' }) {
  const { showReceipt } = useTransactionReceipt();
  return (
    <button onClick={() => showReceipt({ type, data: { amount: '1234.56789012345', token: 'TOWELI', txHash: HASH } })}>
      open receipt
    </button>
  );
}

beforeEach(() => wagmiMock.reset());

describe('stake and lock receipts: the Amount is cut', () => {
  it.each(['stake', 'lock'] as const)('a %s of 1234.56789012345 TOWELI reads 1234.5678, not 1234.5679', (type) => {
    render(
      <TransactionReceiptProvider>
        <Opener type={type} />
      </TransactionReceiptProvider>,
    );
    fireEvent.click(screen.getByText('open receipt'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Amount').nextElementSibling?.textContent).toBe('1234.5678 TOWELI');
  });
});
