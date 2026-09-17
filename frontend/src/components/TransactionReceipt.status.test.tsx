/**
 * The receipt card's status badge must not call a receipt it never read "Failed".
 *
 * wagmi's receipt query errors in two different situations: the transaction
 * reverted (`CallExecutionError`, because wagmi throws on a reverted receipt), or
 * the node never returned a receipt at all (`TransactionReceiptNotFoundError`, for
 * a transaction that may well have succeeded). The badge said "Failed" for both,
 * and disabled sharing as "transaction reverted" on a transaction nobody had read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TransactionReceiptProvider } from './TransactionReceipt';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';

const TX = `0x${'ab'.repeat(32)}` as const;

function Opener() {
  const { showReceipt } = useTransactionReceipt();
  return (
    <button
      onClick={() =>
        showReceipt({ type: 'stake', data: { amount: '1000000000000000000', token: 'TOWELI', txHash: TX } })
      }
    >
      open receipt
    </button>
  );
}

function openWithReceiptError(errorName: string) {
  wagmiMock.setWriteStatus({ hash: TX, isTxError: true, errorName });
  render(
    <TransactionReceiptProvider>
      <Opener />
    </TransactionReceiptProvider>,
  );
  fireEvent.click(screen.getByText('open receipt'));
}

describe('TransactionReceipt status badge', () => {
  beforeEach(() => wagmiMock.reset());

  it('a receipt the node never returned reads "Unconfirmed", not "Failed"', () => {
    openWithReceiptError('TransactionReceiptNotFoundError');
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Unconfirmed');
    expect(screen.getByRole('button', { name: /share to x/i })).not.toBeDisabled();
  });

  it('a revert still reads "Failed" and cannot be shared', () => {
    openWithReceiptError('CallExecutionError');
    expect(screen.getByRole('status')).toHaveTextContent('Failed');
    expect(screen.getByRole('button', { name: /share to x/i })).toBeDisabled();
  });
});
