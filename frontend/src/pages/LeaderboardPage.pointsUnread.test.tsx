/**
 * OUTAGE-AS-ZERO — the Venue Score page's Points / Tier / progress.
 *
 * The page already withheld Points, Tier and the progress bar on a refused swap
 * scan (`swapCountUnread`). The staking, LP and referral reads understate the
 * same total when they fail, and the page printed that understated total as the
 * wallet's score, with a tier and a progress bar drawn from it. It now withholds
 * on `pointsUnread` (either half) and names the contract half in its own notice.
 *
 * usePoints is driven directly here; its flags are pinned in
 * usePoints.metricsUnread.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const pts = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../hooks/usePoints', () => ({ usePoints: () => pts.current }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../components/TegridyScore', () => ({ TegridyScore: () => null }));
vi.mock('../components/HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/AnimatedCounter', () => ({
  AnimatedCounter: ({ value }: { value: number }) => <p>{value}</p>,
}));

import LeaderboardPage from './LeaderboardPage';

/** A wallet on 250 points, tier "Farmhand", 250 short of "Grower". */
function points(flags: { swapCountUnread?: boolean; metricsUnread?: boolean } = {}) {
  const swapCountUnread = flags.swapCountUnread ?? false;
  const metricsUnread = flags.metricsUnread ?? false;
  pts.current = {
    data: { points: 250, referralCount: 0, actions: [], streak: { current: 0 } },
    tier: { name: 'Farmhand', color: '#fff', min: 100 },
    nextTier: { name: 'Grower', min: 500 },
    badges: [],
    referralLink: 'https://example.test/?ref=0x',
    swapCountUnread,
    metricsUnread,
    pointsUnread: swapCountUnread || metricsUnread,
  };
}
const tile = (label: 'Points' | 'Tier') => screen.getByText(label).nextElementSibling?.textContent ?? '';
const positionsNotice = () => screen.queryByTestId('points-positions-unread');
const swapsNotice = () => screen.queryByTestId('points-swaps-unread');

beforeEach(() => points());

describe('LeaderboardPage — position reads UNREAD', () => {
  it('withholds Points, Tier and progress when a staking/LP/referral read failed', () => {
    // OLD: gated on swapCountUnread alone, so this rendered "250", "Farmhand" and
    // a progress bar — an understated score, presented as the wallet's.
    points({ metricsUnread: true });
    render(<LeaderboardPage />);

    expect(tile('Points')).toBe('–');
    expect(tile('Tier')).toBe('–');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(positionsNotice()).toHaveTextContent(/not a statement that you hold no position/i);
    // It is the contract half, not the swap half.
    expect(swapsNotice()).toBeNull();
  });
});

describe('LeaderboardPage — the existing swap signal, and GENUINE', () => {
  // NOT DISCRIMINATING against the old code — both behave identically before and
  // after. The first keeps the pre-existing swap withholding intact; the second
  // fails if withholding ever widens to a wallet whose reads all landed.
  it('a refused swap scan still withholds, under its own notice', () => {
    points({ swapCountUnread: true });
    render(<LeaderboardPage />);

    expect(tile('Points')).toBe('–');
    expect(swapsNotice()).toBeInTheDocument();
    expect(positionsNotice()).toBeNull();
  });

  it('a fully read wallet shows its points, tier and progress', () => {
    render(<LeaderboardPage />);

    expect(tile('Points')).toBe('250');
    expect(tile('Tier')).toBe('Farmhand');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(positionsNotice()).toBeNull();
  });
});
