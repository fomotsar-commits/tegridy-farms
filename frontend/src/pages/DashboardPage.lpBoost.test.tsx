// The Dashboard's LP figures are the ones a stale boost quietly deflates.
//
// "Pending" on the liquidity card accrues against the farm's EFFECTIVE balance,
// so a wallet that staked LP before acquiring its JBAC sees a number that is
// simply low — no error, no gap, nothing that looks wrong. That is the worst
// shape a wrong number can take, and it is why the detection has to reach this
// page and not only the Farm page.
//
// The Dashboard has no write path for it on purpose: refreshBoost is a
// transaction and the Farm page owns that. So what is pinned here is that the
// page SAYS the figure is understated and sends the user somewhere that can fix
// it — and that it says nothing at all when the boost is fine.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ needsRefresh: false }));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
    isReconnecting: false,
    isConnecting: false,
  }),
  useBalance: () => ({ data: undefined }),
  useChainId: () => 1,
  useReadContract: () => ({ data: undefined, isLoading: false, error: null }),
  useReadContracts: () => ({ data: [], refetch: () => {} }),
  useWriteContract: () => ({ writeContract: () => {}, data: undefined, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('../hooks/useAutoRefreshBoost', () => ({
  useAutoRefreshBoost: () => ({ needsRefresh: state.needsRefresh, effectiveBalance: 0n, rawBalance: 0n }),
}));

// A wallet with LP staked in the farm — the only state where the notice applies.
vi.mock('../hooks/useLpPosition', () => ({
  useLpPosition: () => ({
    hasPosition: true,
    lpBalance: 10n ** 18n,
    lpBalanceFormatted: '1',
    walletLp: 0n,
    walletLpFormatted: '0',
    stakedLp: 10n ** 18n,
    stakedLpFormatted: '1',
    sharePct: 1,
    toweliAmount: 100,
    wethAmount: 0.1,
    pendingRewards: 5,
    farmingDeployed: true,
    isLoading: false,
  }),
}));

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({
    priceInEth: 0, priceInUsd: 0, ethUsd: 0, isLoaded: false, oracleStale: false,
    priceChange: 0, priceUnavailable: true, displayPriceStale: false,
    apiPriceDiscrepant: false, priceDiscrepancy: false, twapPriceInEth: 0,
    twapOverrideActive: false, priceSafeForSwaps: false, ethUsdForLaunch: 0,
  }),
}));

vi.mock('../hooks/useUserPosition', () => ({
  useUserPosition: () => ({
    hasPosition: false, positions: [], staked: 0n, stakedFormatted: '0',
    pending: 0n, pendingFormatted: '0', allowance: 0n, boostMultiplier: 1,
    isLocked: false, refetchAll: vi.fn(), isLoading: false,
  }),
}));

vi.mock('../hooks/usePoolData', () => ({
  usePoolData: () => ({ apr: '0', aprNum: 0, isDeployed: false, secondsRemaining: 0, aprDisclaimer: null }),
}));
vi.mock('../hooks/useFarmActions', () => ({
  useFarmActions: () => ({ claim: vi.fn(), isPending: false, isConfirming: false, isSuccess: false, hash: undefined, pendingEth: 0n }),
}));
vi.mock('../hooks/useNFTBoost', () => ({
  useNFTBoost: () => ({ holdsJBAC: true, holdsGoldCard: false, boostLabel: 'JBAC +0.5x', boostMultiplier: 1.5 }),
}));
vi.mock('../hooks/useDCA', () => ({ useDCA: () => ({ dueSchedules: [], schedules: [], isLoading: false }) }));
vi.mock('../hooks/useLimitOrders', () => ({ useLimitOrders: () => ({ activeOrders: [], isLoading: false }) }));
vi.mock('../hooks/useMyLoans', () => ({ useMyLoans: () => ({ loans: [], isLoading: false, isError: false }) }));
vi.mock('../hooks/usePriceHistory', () => ({ usePriceHistory: () => ({ history: [], error: null, isLoading: false }) }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));
vi.mock('../hooks/useNetworkCheck', () => ({ useNetworkCheck: () => ({ isWrongNetwork: false, switchToMainnet: vi.fn() }) }));
vi.mock('../hooks/useRevenueStats', () => ({
  useRevenueStats: () => ({
    totalDistributed: '0', referralEarned: '0', referralPending: '0', referralPendingBig: 0n,
    referredCount: 0, referrer: undefined, hasReferrer: false, setReferrer: vi.fn(),
    claimReferralRewards: vi.fn(), refetch: vi.fn(), isPending: false, isConfirming: false,
  }),
}));
vi.mock('../hooks/useTowelie', () => ({ useTowelie: () => ({ say: vi.fn() }) }));

vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/PositionHealth', () => ({ PositionHealth: () => null }));
vi.mock('../components/TegridyScoreMini', () => ({ TegridyScoreMini: () => null }));
vi.mock('../components/ReferralWidget', () => ({ ReferralWidget: () => null }));
vi.mock('../components/PriceAlertWidget', () => ({ PriceAlertWidget: () => null }));
vi.mock('../components/chart/PriceChart', () => ({ PriceChart: () => null }));
vi.mock('../components/Sparkline', () => ({ Sparkline: () => null }));
vi.mock('../components/ui/ConnectPrompt', () => ({ ConnectPrompt: () => null }));
vi.mock('../components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import DashboardPage from './DashboardPage';

/** The liquidity card lives under the Positions tab, not the default Overview. */
function renderPositionsTab() {
  const result = render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('tab', { name: /positions/i }));
  return result;
}

beforeEach(() => {
  state.needsRefresh = false;
});

describe('Dashboard LP boost notice', () => {
  it('stays silent when the boost is applied — no notice on a healthy position', () => {
    renderPositionsTab();
    expect(screen.queryByText(/unboosted rate/i)).toBeNull();
  });

  it('marks the pending figure as understated and routes to where it can be fixed', () => {
    state.needsRefresh = true;
    renderPositionsTab();
    // Naming the consequence is the whole job: a low number that looks fine is
    // the failure mode, so the notice has to say the figure itself is wrong.
    expect(screen.getByText(/accruing at the unboosted rate/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /farm page/i });
    expect(link.getAttribute('href')).toBe('/farm');
  });
});
