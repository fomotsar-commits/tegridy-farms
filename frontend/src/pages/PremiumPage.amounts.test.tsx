// The Gold Card page: a plan's price is paid, so it is rounded UP at the digits shown; the
// visitor's TOWELI balance is held, so it is cut, never printed above what the wallet has.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const E18 = 10n ** 18n;

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true }) }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough };
});
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ui/CardArt', () => ({ CardArt: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));
vi.mock('../hooks/usePremiumAccess', () => ({
  usePremiumAccess: () => ({
    // 1,234.5671 TOWELI a month; the wallet holds 5,678.1239 TOWELI.
    monthlyFee: 12_345_671n * E18 / 10_000n, monthlyFeeFormatted: 1234.5671, totalRevenueFormatted: 0,
    userBalance: 56_781_239n * E18 / 10_000n, userBalanceFormatted: 5678.1239, totalSubscribers: 0, statsUnread: false,
    hasPremium: false, premiumUnread: false, holdsJBAC: false, jbacUnread: false, quoteUnread: false,
    isDataLoading: false, isDataError: false, dataError: null, needsApproval: () => true,
    isPending: false, isConfirming: false, isApproveSuccess: false, approveHash: undefined,
    isActionSuccess: false, actionHash: undefined, approveToweli: vi.fn(), subscribe: vi.fn(), activateNFTPremium: vi.fn(),
  }),
}));
vi.mock('../hooks/useRevenueStats', () => ({
  useRevenueStats: () => ({
    totalDistributed: 0, epochCount: 0, globalUnread: false, pendingRevenue: 0, pendingRevenueBig: 0n,
    referralPending: 0, referralPendingBig: 0n, referredCount: 0, isDataLoading: false, isDataError: false, dataError: null,
    claimRevenue: vi.fn(), claimReferralRewards: vi.fn(), refetch: vi.fn(), isPending: false, isConfirming: false, isSuccess: false, hash: undefined,
  }),
}));

import PremiumPage from './PremiumPage';

describe('Gold Card amounts', () => {
  it('a plan price is rounded up, and the Monthly Fee tile names the same figure', () => {
    render(<MemoryRouter><PremiumPage /></MemoryRouter>);
    // One month is 1,234.5671: at three decimals that is 1,234.568 paid, never 1,234.567.
    expect(within(screen.getByRole('button', { name: /^1 Month/ })).getByText('1,234.568 TOWELI')).toBeInTheDocument();
    expect(screen.getByText('Monthly Fee').nextElementSibling?.textContent).toBe('1,234.568 TOWELI');
    expect(screen.queryByText('1,234.567 TOWELI')).toBeNull();
  });

  it('the balance is cut: 5,678.1239 held reads 5,678.123, never 5,678.124', () => {
    render(<MemoryRouter><PremiumPage /></MemoryRouter>);
    expect(screen.getByText('Your Balance').nextElementSibling?.textContent).toBe('5,678.123 TOWELI');
  });
});
