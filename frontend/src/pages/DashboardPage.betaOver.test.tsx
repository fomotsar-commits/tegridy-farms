/**
 * TOWELI staking v1 is closing (owner, 2026-10-30). The dashboard's half: the
 * "Beta is over" notice for a wallet with something staked, no invitation to stake,
 * and no Claim button armed during a pause (getReward is whenNotPaused).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  needsRefresh: false,
  pos: {} as Record<string, unknown>,
  pool: {} as Record<string, unknown>,
}));

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
    lpUnread: false,
    reservesUnread: false,
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

vi.mock('../hooks/useUserPosition', () => ({ useUserPosition: () => state.pos }));

vi.mock('../hooks/usePoolData', () => ({ usePoolData: () => state.pool }));
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


import { BETA_OVER_LINE, NEW_STAKES_CLOSED_LINE } from '../lib/stakingBetaOver';

const E18 = 10n ** 18n;

function renderTab(name: RegExp) {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  // Stand in the TOWELI room, at its address (see DashboardPage.lpBoost.test).
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
  window.history.replaceState({}, '', '/dashboard');
  state.needsRefresh = false;
  // 1,000 TOWELI staked, 42.5 earned. Rate 0, the reserve holds 5,000: claim now.
  state.pos = {
    hasPosition: true, positionUnread: false, isPaused: false, isLoading: false, tokenId: 7n,
    stakedFormatted: '1000', pendingFormatted: '42.5', pendingReward: 425n * E18 / 10n, pendingLive: 42.5,
    accrualPerSec: 0, unsettledRewards: 0n, unsettledFormatted: '0', allowance: 0n, boostMultiplier: 2,
    isLocked: true, lockEnd: Math.floor(Date.now() / 1000) + 40 * 86_400, autoMaxLock: false, refetchAll: vi.fn(),
  };
  state.pool = {
    apr: '0', aprNum: 0, isDeployed: true, isDry: false, secondsRemaining: 0, aprDisclaimer: null,
    totalStaked: '0', rewardRateRaw: 0n, rewardRateUnread: false,
    rewardsRemainingRaw: 5000n * E18, rewardsRemainingUnread: false, paused: false, isLoading: false, refetch: vi.fn(),
  };
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
  window.history.replaceState({}, '', '/');
});

describe('Dashboard, beta over', () => {
  it('tells a wallet with a stake where v1 stands', () => {
    renderTab(/positions/i);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE['claim-now']);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
  });

  it('during a read pause it says so, and no Claim button is armed', () => {
    state.pos = { ...state.pos, isPaused: true };
    renderTab(/positions/i);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE.paused);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeDisabled();
  });

  it('the Rewards tab disarms Claim during a pause too', () => {
    state.pos = { ...state.pos, isPaused: true };
    renderTab(/rewards/i);
    expect(screen.getByRole('button', { name: /claim staking rewards/i })).toBeDisabled();
  });

  it('a wallet with no position is told v1 takes no new stakes, not invited to start', () => {
    state.pos = { ...state.pos, hasPosition: false, stakedFormatted: '0', pendingFormatted: '0', pendingReward: 0n };
    renderTab(/positions/i);
    expect(screen.getByTestId('dashboard-staking-v1-closed')).toHaveTextContent(NEW_STAKES_CLOSED_LINE);
    expect(screen.queryByRole('link', { name: /start staking/i })).toBeNull();
    // Nothing staked, nothing owed: no notice for it.
    expect(screen.queryByTestId('staking-beta-over')).toBeNull();
  });
});
