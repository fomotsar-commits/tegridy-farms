/**
 * The receipt card's status badge: a revert says Reverted, and a receipt nobody
 * could read says Unconfirmed — never "Failed".
 *
 * wagmi's `isError` covers two facts (lib/txErrors.ts): a revert, which wagmi
 * THROWS rather than returning as a receipt, and a receipt it could not read.
 * The badge used to print "Failed" and disable Share for every `isError`, which
 * is a claim about a transaction nobody saw revert. The errors below are the real
 * viem types wagmi throws.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TransactionReceiptProvider } from './TransactionReceipt';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';

const HASH = `0x${'ab'.repeat(32)}` as const;

function Opener() {
  const { showReceipt } = useTransactionReceipt();
  return (
    <button onClick={() => showReceipt({ type: 'stake', data: { amount: '1', token: 'TOWELI', txHash: HASH } })}>
      open receipt
    </button>
  );
}

function open() {
  render(
    <TransactionReceiptProvider>
      <Opener />
    </TransactionReceiptProvider>,
  );
  fireEvent.click(screen.getByText('open receipt'));
  return screen.getByRole('dialog');
}

const shareButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /share to x/i });

beforeEach(() => wagmiMock.reset());

describe('TransactionReceipt status badge', () => {
  it('a thrown revert reads Reverted, and Share is disabled', () => {
    wagmiMock.setWriteStatus({
      hash: HASH,
      receiptError: new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {}),
    });
    const dialog = open();
    expect(within(dialog).getByText('Reverted')).toBeInTheDocument();
    expect(within(dialog).queryByText('Failed')).toBeNull();
    expect(shareButton(dialog)).toBeDisabled();
  });

  it('an unreadable receipt reads Unconfirmed — not Failed — and sharing asks first', () => {
    wagmiMock.setWriteStatus({ hash: HASH, receiptError: new TransactionReceiptNotFoundError({ hash: HASH }) });
    const dialog = open();
    expect(within(dialog).getByText('Unconfirmed')).toBeInTheDocument();
    expect(within(dialog).queryByText('Failed')).toBeNull();
    expect(within(dialog).queryByText('Reverted')).toBeNull();

    const share = shareButton(dialog);
    expect(share).toBeEnabled();
    fireEvent.click(share);
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText(/couldn.?t confirm this tx/i)).toBeInTheDocument();
    expect(within(ask).getByText(/can.?t tell whether it went through/i)).toBeInTheDocument();
  });
});
