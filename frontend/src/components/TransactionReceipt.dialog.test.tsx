/**
 * A11Y-R01 — the global transaction-receipt overlay is a dialog.
 *
 * It is the one overlay every user meets: it appears after EVERY transaction on
 * the site, covers the viewport at z-[9999], and used to be dismissible only by
 * a mouse (backdrop click or the Close button). These assertions pin the three
 * things that were missing — dialog semantics with a name, Escape, and focus
 * moved into the card — and all three fail on the pre-change component.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TransactionReceiptProvider } from './TransactionReceipt';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';

function Opener() {
  const { showReceipt } = useTransactionReceipt();
  return (
    <button
      onClick={() =>
        showReceipt({ type: 'stake', data: { amount: '1000000000000000000', token: 'TOWELI' } })
      }
    >
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
}

describe('TransactionReceiptOverlay — dialog contract', () => {
  beforeEach(() => wagmiMock.reset());

  it('exposes the receipt as a named modal dialog', () => {
    open();
    // RECEIPT_COPY.stake.label is the card's headline; aria-labelledby points
    // at it, so the dialog is announced by what it is rather than as "dialog".
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog).toHaveAccessibleName(/\S/);
  });

  it('closes on Escape', () => {
    open();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the card on open, so the first Tab stays inside it', async () => {
    open();
    // useFocusTrap focuses the first focusable descendant on the next frame.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
