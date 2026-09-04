// PERF-10. The subscription draft used to be JSON-serialised and written to
// localStorage on EVERY change of the whole draft object. Two of its fields are
// free-text inputs, so typing a 42-character merchant address cost 42
// serialisations and 42 synchronous, blocking storage writes — on /checkout,
// while the payer is mid-keystroke.
//
// What is pinned here is the PROPERTY, not the delay: a burst of keystrokes
// costs one write, and the last keystroke still survives an unmount. A test that
// asserted "exactly 250ms" would fail the moment the constant is tuned and would
// still pass if the debounce dropped the final edit — which is the failure that
// actually costs a payer something.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const PAYER = '0x2222222222222222222222222222222222222222' as const;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: PAYER, isConnected: true, chain: { id: 1 } }),
  useChainId: () => 1,
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn() }),
}));

// The panel's chain reads are not what this file is about, and mounting them
// would drag a wagmi provider in for nothing.
vi.mock('../../hooks/useCheckoutSubscription', () => ({
  useCheckoutSubscription: () => ({
    status: 'idle',
    allowance: null,
    balance: null,
    verdict: null,
    refetch: vi.fn(),
  }),
}));

const safeSetItem = vi.fn((_key: string, _value: string) => true);
vi.mock('../../lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/storage')>();
  return { ...actual, safeSetItem: (k: string, v: string) => safeSetItem(k, v) };
});

import { SubscriptionPanel } from './SubscriptionPanel';

beforeEach(() => {
  localStorage.clear();
  safeSetItem.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function typeMerchant(text: string) {
  const input = screen.getByLabelText(/merchant address/i);
  for (let i = 1; i <= text.length; i += 1) {
    fireEvent.change(input, { target: { value: text.slice(0, i) } });
  }
}

describe('the subscription draft is not written on every keystroke', () => {
  it('spends one storage write on a burst of ten changes', () => {
    render(<SubscriptionPanel />);
    safeSetItem.mockClear();

    act(() => {
      typeMerchant('0x1111111111');
    });
    // Mid-burst: nothing has been committed yet.
    expect(safeSetItem).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    const drafts = safeSetItem.mock.calls.filter((c) => c[0] === 'tegridy_subscription_draft_v1');
    expect(drafts).toHaveLength(1);
    expect(String(drafts[0]?.[1])).toContain('0x1111111111');
  });

  it('still persists the last edit when the panel unmounts mid-debounce', () => {
    const { unmount } = render(<SubscriptionPanel />);
    safeSetItem.mockClear();

    act(() => {
      typeMerchant('0xabc');
    });
    expect(safeSetItem).not.toHaveBeenCalled();

    // Closing the tab a keystroke after typing must not lose the keystroke.
    unmount();

    const drafts = safeSetItem.mock.calls.filter((c) => c[0] === 'tegridy_subscription_draft_v1');
    expect(drafts).toHaveLength(1);
    expect(String(drafts[0]?.[1])).toContain('0xabc');
  });
});
