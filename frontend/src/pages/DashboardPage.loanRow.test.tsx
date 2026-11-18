/**
 * The dashboard's Loans tab, from the wallet's side of each loan, as the lending tab's loan card
 * it links to reads it. A borrower owes the loan amount back, so their row and the Borrowing total
 * round up at the last digit shown; the row says "You borrowed", as repaying costs more. A lender
 * is owed it, so their row and the Lending total are cut. Both keep the same four-decimal shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ loans: [] as unknown[] }));

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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock('../hooks/useAutoRefreshBoost', () => ({
  useAutoRefreshBoost: () => ({ needsRefresh: false, effectiveBalance: 0n, rawBalance: 0n }),
}));
vi.mock('../hooks/useLpPosition', () => ({
  useLpPosition: () => ({
    hasPosition: false, lpBalance: 0n, lpBalanceFormatted: '0', walletLp: 0n, walletLpFormatted: '0', stakedLp: 0n,
    stakedLpFormatted: '0', sharePct: 0, toweliAmount: 0, wethAmount: 0, pendingRewards: 0, farmingDeployed: true,
    isLoading: false, lpUnread: false, reservesUnread: false,
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
    hasPosition: false, positionUnread: false, isPaused: false, isLoading: false, tokenId: 0n,
    stakedFormatted: '0', pendingFormatted: '0', pendingReward: 0n, pendingLive: 0, accrualPerSec: 0,
    unsettledRewards: 0n, unsettledFormatted: '0', allowance: 0n, boostMultiplier: 1, isLocked: false,
    lockEnd: 0, autoMaxLock: false, refetchAll: vi.fn(),
  }),
}));
vi.mock('../hooks/usePoolData', () => ({
  usePoolData: () => ({
    apr: '0', aprNum: 0, isDeployed: true, isDry: false, secondsRemaining: 0, aprDisclaimer: null,
    totalStaked: '0', rewardRateRaw: 0n, rewardRateUnread: false, rewardsRemaining: '0',
    rewardsRemainingRaw: 0n, rewardsRemainingUnread: false, paused: false, isLoading: false, refetch: vi.fn(),
  }),
}));
vi.mock('../hooks/useFarmActions', () => ({
  useFarmActions: () => ({ claim: vi.fn(), isPending: false, isConfirming: false, isSuccess: false, hash: undefined, pendingEth: 0n }),
}));
vi.mock('../hooks/useNFTBoost', () => ({
  useNFTBoost: () => ({ holdsJBAC: false, holdsGoldCard: false, boostLabel: '', boostMultiplier: 1 }),
}));
vi.mock('../hooks/useDCA', () => ({ useDCA: () => ({ dueSchedules: [], schedules: [], isLoading: false }) }));
vi.mock('../hooks/useLimitOrders', () => ({ useLimitOrders: () => ({ activeOrders: [], isLoading: false }) }));
vi.mock('../hooks/useMyLoans', () => ({ useMyLoans: () => ({ loans: state.loans, isLoading: false, isError: false, unreadCount: 0 }) }));
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
vi.mock('../components/ui/CardArt', () => ({ CardArt: () => null }));
vi.mock('../components/PositionHealth', () => ({ PositionHealth: () => null }));
vi.mock('../components/ReferralWidget', () => ({ ReferralWidget: () => null }));
vi.mock('../components/PriceAlertWidget', () => ({ PriceAlertWidget: () => null }));
vi.mock('../components/chart/PriceChart', () => ({ PriceChart: () => null }));
vi.mock('../components/Sparkline', () => ({ Sparkline: () => null }));
vi.mock('../components/ui/ConnectPrompt', () => ({ ConnectPrompt: () => null }));
vi.mock('../components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import DashboardPage from './DashboardPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

const DAY = 86_400n;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const loan = (id: number, role: 'borrower' | 'lender', principal: bigint) => ({
  id, role, borrower: '0x1111111111111111111111111111111111111111', lender: '0x2222222222222222222222222222222222222222',
  tokenId: 77n, collateralContract: '0x3333333333333333333333333333333333333333', principal, aprBps: 1000n,
  startTime: now() - DAY, deadline: now() + 10n * DAY, loan: {}, repaid: false, defaultClaimed: false, status: 'active',
});

function openLoans() {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('tab', { name: /loans/i }));
}

beforeEach(() => {
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
  window.history.replaceState({}, '', '/dashboard');
  // 0.10007 ETH borrowed: rounded up it is 0.1001, cut 0.1000. 0.100049 ETH lent: cut it is
  // 0.1000, rounded up 0.1001.
  state.loans = [loan(11, 'borrower', 100_070_000_000_000_000n), loan(12, 'lender', 100_049_000_000_000_000n)];
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
  window.history.replaceState({}, '', '/');
});

describe('Dashboard loan rows, from the wallet’s side', () => {
  it('a borrower’s row says "You borrowed" and names the loan amount rounded up: they owe it back', () => {
    openLoans();
    expect(screen.getByText(/^You borrowed /)).toHaveTextContent('You borrowed 0.1001 ETH');
    expect(screen.queryByText(/^You owe /)).toBeNull();
  });

  it('a lender’s row names what they are owed back cut, in the same shape', () => {
    openLoans();
    expect(screen.getByText(/^You lent /)).toHaveTextContent('You lent 0.1000 ETH');
  });

  it('the totals take the same sides: principal borrowed rounded up, ETH lent out cut', () => {
    openLoans();
    expect(screen.getByText(/ETH principal$/)).toHaveTextContent('0.1001 ETH principal');
    expect(screen.getByText(/ETH out$/)).toHaveTextContent('0.1000 ETH out');
  });
});
