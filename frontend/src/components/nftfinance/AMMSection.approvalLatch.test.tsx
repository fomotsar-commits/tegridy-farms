/**
 * The NFT AMM's sell-side approval releases its latch when the approval's
 * receipt wait fails, not only when it succeeds.
 *
 * Approve sets `approvalStep = 'approving'`, which disables "Step 1: Approve
 * Collection" until the approval's receipt resolves. The only release on a
 * failed approval was a revert derived as `isSuccess && status !== 'success'` —
 * but wagmi THROWS on a reverted receipt (lib/txErrors.ts), so that branch never
 * fired: a reverted approval, or one whose receipt could not be read, left the
 * button on "Approving..." for the rest of the session.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError, parseEther } from 'viem';
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

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const COLLECTION = '0x2222222222222222222222222222222222222222' as const;
const POOL = '0x3333333333333333333333333333333333333333' as const;
const HASH = `0x${'ef'.repeat(32)}` as const;

function openSellApproval() {
  renderWithProviders(<AMMSection />);
  fireEvent.click(screen.getByRole('button', { name: /sell nfts/i }));
  // The trade tab renders BuySellPanel first, then PoolExplorer (its own 0x... field).
  fireEvent.change(screen.getAllByPlaceholderText('0x...')[0]!, { target: { value: COLLECTION } });
  fireEvent.change(screen.getByPlaceholderText('1, 42, 100'), { target: { value: '1' } });
  return screen.getByRole('button', { name: /approve collection|approving/i });
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setReadResult({ functionName: 'getBestSellPool', result: [POOL, parseEther('1')] });
  wagmiMock.setReadResult({ functionName: 'isApprovedForAll', result: false });
});

const errors: Array<[string, () => unknown]> = [
  ['a revert wagmi THREW', () => new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {})],
  ['an unreadable receipt', () => new TransactionReceiptNotFoundError({ hash: HASH })],
];

describe('AMM sell-side approval latch', () => {
  for (const [label, make] of errors) {
    it(`${label} gives the Approve button back`, () => {
      const approve = openSellApproval();
      expect(approve).toBeEnabled();

      // The approval is signed, then its receipt wait fails.
      wagmiMock.setWriteStatus({ hash: HASH, receiptError: make() });
      fireEvent.click(approve);

      const after = screen.getByRole('button', { name: /approve collection|approving/i });
      expect(after).toHaveTextContent('Step 1: Approve Collection');
      expect(after).toBeEnabled();
    });
  }
});
