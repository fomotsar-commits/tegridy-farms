/**
 * Bounties and Grants: a revert and an unreadable receipt each read as themselves.
 *
 * Both sections fold wagmi's receipt wait into one write effect. wagmi reports a
 * genuine revert AND a receipt it could not read on the same `isError` flag (it
 * THROWS on a reverted receipt), so before receiptOutcome both sections toasted
 * "Transaction failed" for either one. The hooks' version of this is pinned in
 * hooks/receiptStatus.test.ts; these two components render the same split and are
 * pinned here. The errors are the real viem types wagmi throws — see the
 * measurement table in lib/txErrors.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError } from 'viem';
import { toast } from 'sonner';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

import { BountiesSection } from './BountiesSection';
import { GrantsSection } from './GrantsSection';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const HASH = '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' as const;

const SECTIONS = [
  { name: 'BountiesSection', render: () => renderWithProviders(<BountiesSection />) },
  { name: 'GrantsSection', render: () => renderWithProviders(<GrantsSection />) },
];

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
});

for (const { name, render } of SECTIONS) {
  describe(name, () => {
    it('a receipt that could not be read is not called a failure, and says we cannot tell', () => {
      wagmiMock.setWriteStatus({ hash: HASH, receiptError: new TransactionReceiptNotFoundError({ hash: HASH }) });
      render();

      const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
      expect(errors.filter((m) => /fail|revert/i.test(m)), 'an unread receipt was reported as a failure').toEqual([]);

      expect(toast.warning).toHaveBeenCalled();
      const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, Record<string, unknown>];
      expect(title).toMatch(/couldn.?t confirm/i);
      expect(String(opts.description)).toMatch(/can.?t tell whether it went through/i);
      expect(String(opts.description)).toMatch(/0xfeedfeed/);
      expect(opts.action).toBeTruthy();
    });

    it('a genuine revert (thrown by wagmi) says it reverted, never that it is unconfirmed', () => {
      wagmiMock.setWriteStatus({
        hash: HASH,
        receiptError: new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {}),
      });
      render();

      expect(toast.warning, 'a revert was told it could not be confirmed').not.toHaveBeenCalled();
      const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
      expect(errors.some((m) => /reverted on-chain/i.test(m)), `toasts: ${JSON.stringify(errors)}`).toBe(true);
      expect(errors.filter((m) => /^transaction failed/i.test(m))).toEqual([]);
    });
  });
}

// viem RESOLVES a replaced wait with the replacement's receipt; a wallet
// cancel's says success (lib/txErrors.receipt.test.ts).
for (const { name, render } of SECTIONS) {
  describe(`${name}: a tx the wallet cancelled`, () => {
    it('is not "confirmed", and says it was cancelled and did not happen', async () => {
      const { noteReplacement } = await import('../../lib/txErrors');
      const submitted = `0x${'5c'.repeat(32)}` as const;
      noteReplacement({ reason: 'cancelled', replacedTransaction: { hash: submitted } });
      wagmiMock.setWriteStatus({
        hash: submitted, isSuccess: true, receiptStatus: 'success', receiptHash: `0x${'0d'.repeat(32)}`,
      });
      render();

      expect(vi.mocked(toast.success).mock.calls.map(([m]) => String(m)), 'a cancel read as the action').toEqual([]);
      const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, Record<string, unknown>];
      expect(title).toMatch(/cancel/i);
      expect(String(opts.description)).toMatch(/did not happen/i);
    });
  });
}
