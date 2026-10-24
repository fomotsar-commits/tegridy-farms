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
import { noteReplacement } from '../lib/txErrors';

const HASH = `0x${'ab'.repeat(32)}` as const;

function Opener({ txHash }: { txHash: string }) {
  const { showReceipt } = useTransactionReceipt();
  return (
    <button onClick={() => showReceipt({ type: 'stake', data: { amount: '1', token: 'TOWELI', txHash } })}>
      open receipt
    </button>
  );
}

function open(txHash: string = HASH) {
  render(
    <TransactionReceiptProvider>
      <Opener txHash={txHash} />
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

// When the wallet replaces the tx at its nonce, viem RESOLVES the wait with the
// replacement's receipt (lib/txErrors.receipt.test.ts); a cancel's says success.
describe('TransactionReceipt status badge, for a tx the wallet replaced', () => {
  const OTHER = `0x${'0d'.repeat(32)}` as const;

  it('a cancelled tx reads Replaced, never Confirmed, and Share is disabled', () => {
    const cancelled = `0x${'c1'.repeat(32)}` as const;
    noteReplacement({ reason: 'cancelled', replacedTransaction: { hash: cancelled } });
    wagmiMock.setWriteStatus({ hash: cancelled, isSuccess: true, receiptHash: OTHER, receiptStatus: 'success' });
    const dialog = open(cancelled);
    expect(within(dialog).getByText('Replaced')).toBeInTheDocument();
    expect(within(dialog).queryByText('Confirmed'), 'a cancel read as the stake').toBeNull();
    expect(shareButton(dialog)).toBeDisabled();
  });

  it('a sped-up tx is the same call, so it reads Confirmed', () => {
    const sped = `0x${'c2'.repeat(32)}` as const;
    noteReplacement({ reason: 'repriced', replacedTransaction: { hash: sped } });
    wagmiMock.setWriteStatus({ hash: sped, isSuccess: true, receiptHash: OTHER, receiptStatus: 'success' });
    const dialog = open(sped);
    expect(within(dialog).getByText('Confirmed')).toBeInTheDocument();
    expect(shareButton(dialog)).toBeEnabled();
  });
});
