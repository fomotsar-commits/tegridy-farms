// ProtocolStats — the landing-page stat wall.
//
// What this file protects: the wall is a mix of LIVE on-chain figures and
// EVERGREEN claims, and the two are rendered identically. So the live half must
// never paint a figure it did not read (a failed multicall collapses to 0n
// upstream, and a "$0 volume / 0 staked" wall reads as a dead protocol), and the
// evergreen half must never carry an aggregate a visitor cannot check — the
// exact class of claim the Security page deliberately refuses to publish.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';
import { render, screen } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ ethUsd: 3000, priceInUsd: 0.00004 }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, {
    get: () => ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  });
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

import { ProtocolStats } from './ProtocolStats';

const LIVE_LABELS = [
  /Total Volume/i,
  /Protocol Fees Collected/i,
  /Reward Pool/i,
  /Daily Emissions/i,
  /Total Staked/i,
];

describe('ProtocolStats', () => {
  beforeEach(() => wagmiMock.reset());

  it('renders no live figure when every read fails', () => {
    const { container } = render(<ProtocolStats />);
    for (const label of LIVE_LABELS) {
      expect(screen.queryByText(label), `${label} rendered off a failed read`).toBeNull();
    }
    // A failed read must not become a confident zero anywhere on the wall.
    expect(container.textContent).not.toMatch(/\$0\b/);
    expect(container.textContent).not.toMatch(/\b0 TOWELI\b/);
  });

  it('renders no live figure when the chain genuinely reads zero', () => {
    for (const fn of ['totalETHFees', 'feeBps', 'totalStaked', 'totalRewardsFunded', 'rewardRate']) {
      wagmiMock.setReadResult({ functionName: fn, result: 0n });
    }
    for (const label of LIVE_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('lights up a live card once the chain supplies a real figure', () => {
    wagmiMock.setReadResult({ functionName: 'totalStaked', result: 5_000_000n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'totalRewardsFunded', result: 6_400_000n * 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'rewardRate', result: 10n ** 18n });
    wagmiMock.setReadResult({ functionName: 'totalETHFees', result: 0n });
    wagmiMock.setReadResult({ functionName: 'feeBps', result: 50n });
    render(<ProtocolStats />);
    expect(screen.getByText(/Reward Pool/i)).toBeTruthy();
    expect(screen.getByText(/Total Staked/i)).toBeTruthy();
    // Volume is derived from fees ÷ feeRate; zero fees must stay off the wall
    // rather than render "$0 all-time volume".
    expect(screen.queryByText(/Total Volume/i)).toBeNull();
  });

  // HONESTY GUARD on the evergreen half.
  describe('evergreen claims', () => {
    it('carries no unverifiable aggregate count', () => {
      const { container } = render(<ProtocolStats />);
      const text = container.textContent ?? '';
      // "82+ findings resolved", "1,500+ tests", "12 audits" — any bare
      // countable superlative a visitor cannot check in one click.
      expect(text).not.toMatch(/\d[\d,]*\+?\s*(findings?|audits?|issues?|vulnerabilit)/i);
    });

    it('never claims a fixed fee split, which is a governable on-chain parameter', () => {
      const { container } = render(<ProtocolStats />);
      expect(container.textContent ?? '').not.toMatch(/100%\s*(to|→)?\s*stakers/i);
    });

    it('points the security verdict at the surface that actually computes it', () => {
      const { container } = render(<ProtocolStats />);
      // The card states a verdict it does not itself derive; it must at least
      // name where the live per-address check lives.
      expect(container.textContent ?? '').toMatch(/\/contracts/);
    });
  });
});
