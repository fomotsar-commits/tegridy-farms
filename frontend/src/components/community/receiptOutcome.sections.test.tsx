/**
 * The bounty board and the grants section must not call an unread receipt a failure.
 *
 * Both sections toasted "Transaction failed" whenever wagmi's receipt query
 * errored. That query errors for a revert (`CallExecutionError`: wagmi throws on a
 * reverted receipt) and for a receipt the node never returned
 * (`TransactionReceiptNotFoundError`, for a transaction that may well have landed).
 * Only the first is a failure. "Failed" on the second tells the user to post,
 * submit, claim or vote again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { toast } from 'sonner';

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

const TX = `0x${'cd'.repeat(32)}` as const;
const USER = '0x00000000000000000000000000000000000000A1' as const;

const SECTIONS = [
  { name: 'BountiesSection', Section: BountiesSection },
  { name: 'GrantsSection', Section: GrantsSection },
];

describe('community sections: receipt errors', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  for (const { name, Section } of SECTIONS) {
    it(`${name}: a receipt the node never returned is not called a failure`, () => {
      wagmiMock.setWriteStatus({ hash: TX, isTxError: true, receiptErrorOnly: true, errorName: 'TransactionReceiptNotFoundError' });
      renderWithProviders(<Section />);
      const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
      expect(errors.filter((m) => /fail|revert/i.test(m))).toEqual([]);
      const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [string, { description?: string; action?: unknown }];
      expect(title).toMatch(/couldn.?t confirm/i);
      expect(opts.description).toMatch(/may well have succeeded/i);
      expect(opts.action).toBeTruthy();
    });

    it(`${name}: a revert still says it reverted`, () => {
      wagmiMock.setWriteStatus({ hash: TX, isTxError: true, receiptErrorOnly: true, errorName: 'CallExecutionError' });
      renderWithProviders(<Section />);
      expect(toast.warning).not.toHaveBeenCalled();
      const errors = vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
      expect(errors.some((m) => /reverted/i.test(m)), JSON.stringify(errors)).toBe(true);
    });
  }
});
