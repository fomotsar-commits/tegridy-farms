import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { WalletConnectWatchdog, WALLET_STALL_NOTICE_MS } from './WalletConnectWatchdog';

const useAccountMock = vi.fn();
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
}));

function renderAt(status: string) {
  useAccountMock.mockReturnValue({ status });
  return render(<WalletConnectWatchdog />);
}

/** Push past the stall threshold. */
function advancePastThreshold() {
  act(() => {
    vi.advanceTimersByTime(WALLET_STALL_NOTICE_MS + 1);
  });
}

const NOTICE = /hasn't responded yet/i;

describe('WalletConnectWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAccountMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent while a connection is still within the normal wait', () => {
    renderAt('connecting');
    act(() => {
      vi.advanceTimersByTime(WALLET_STALL_NOTICE_MS - 1);
    });
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('surfaces the notice once connecting outlasts the threshold', () => {
    renderAt('connecting');
    advancePastThreshold();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('names the stuck-popup remedy rather than just reporting failure', () => {
    renderAt('connecting');
    advancePastThreshold();
    // The whole point of the notice is telling the user what to DO. Pin the
    // remedy, not the exact sentence.
    expect(screen.getByRole('status')).toHaveTextContent(/extension/i);
    expect(screen.getByRole('status')).toHaveTextContent(/reload/i);
  });

  it.each(['disconnected', 'connected'])(
    'never fires for status %s, however long it lasts',
    (status) => {
      renderAt(status);
      advancePastThreshold();
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    },
  );

  it('ignores reconnecting, which is slow on every normal page load', () => {
    // Regression guard: watching `reconnecting` would show this notice to
    // returning users who did nothing wrong.
    renderAt('reconnecting');
    advancePastThreshold();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('clears itself when the connection finally lands', () => {
    const { rerender } = renderAt('connecting');
    advancePastThreshold();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();

    useAccountMock.mockReturnValue({ status: 'connected' });
    rerender(<WalletConnectWatchdog />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('renders above the RainbowKit modal so it is not hidden by the spinner', () => {
    renderAt('connecting');
    advancePastThreshold();
    // RainbowKit pins its modal at 2147483646; anything lower is invisible.
    const z = Number(screen.getByRole('status').style.zIndex);
    expect(z).toBeGreaterThan(2147483646);
  });

  it('does not trap the user — the notice can be dismissed', async () => {
    renderAt('connecting');
    advancePastThreshold();

    const dismiss = screen.getByRole('button', { name: /dismiss/i });
    act(() => {
      dismiss.click();
    });
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
