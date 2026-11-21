// The Tokenomics page's Price and FDV counters print a price and a value, not an amount the
// visitor gets or pays, so each rounds to the nearest digit shown. A cut reads one digit low.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TOWELI_TOTAL_SUPPLY } from '../lib/constants';

// $0.012345678987: six decimals at the nearest is 0.012346 (a cut is 0.012345), and the
// FDV, 12,345,678.987 at two decimals, is 12,345,678.99 (a cut is 12,345,678.98).
const PRICE = 0.012345678987;

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPrice: () => ({ priceInUsd: PRICE }) }));
vi.mock('../hooks/usePoolData', () => ({
  usePoolData: () => ({
    rewardRate: '0', totalRewardsFunded: '0', rewardsRemaining: '0', secondsRemaining: 0, isDeployed: false,
    rewardRateUnread: false, rewardsFundedUnread: false, isLoading: false, isDry: false,
  }),
}));
vi.mock('../hooks/usePriceHistory', () => ({ usePriceHistory: () => ({ history: [], error: null, isLoading: false }) }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/Sparkline', () => ({ Sparkline: () => null }));

import TokenomicsPage from './TokenomicsPage';

/** The counter printed under a token-info card's label. */
const counter = (label: string) => screen.getByText(label, { selector: 'p.label-pill' }).nextElementSibling?.querySelector('span')?.textContent;

describe('Tokenomics token-info counters', () => {
  it('the price and the FDV round to the nearest digit shown, never cut', () => {
    render(<TokenomicsPage />);
    expect(TOWELI_TOTAL_SUPPLY).toBe(1_000_000_000);
    expect(counter('Price')).toBe('$0.012346');
    expect(counter('FDV')).toBe('$12,345,678.99');
  });
});
