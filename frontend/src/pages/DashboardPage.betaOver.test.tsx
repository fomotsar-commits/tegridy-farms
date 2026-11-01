/**
 * TOWELI staking v1 is closing (owner, 2026-10-30); since staking release 1 it is the
 * OLD contract. The dashboard's half: the "Beta is over" notice, from v1's own reads,
 * for a wallet with something there; the new contract's position, its invitation to
 * stake, and no Claim button armed during ITS pause (getReward is whenNotPaused).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  needsRefresh: false,
  pos: {} as Record<string, unknown>,
  pool: {} as Record<string, unknown>,
  oldPos: {} as Record<string, unknown>,
  oldPool: {} as Record<string, unknown>,
}));
// Each contract its own reads: v1 (the old contract) is the one that takes no stakes.
const isOld = (c?: { acceptsStakes: boolean }) => c?.acceptsStakes === false;

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

vi.mock('../hooks/useUserPosition', () => ({
  useUserPosition: (c?: { acceptsStakes: boolean }) => (isOld(c) ? state.oldPos : state.pos),
}));

vi.mock('../hooks/usePoolData', () => ({
  usePoolData: (c?: { acceptsStakes: boolean }) => (isOld(c) ? state.oldPool : state.pool),
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


import { BETA_OVER_LINE } from '../lib/stakingBetaOver';

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
  // On the new contract: 1,000 TOWELI staked, 42.5 earned.
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
  // On v1: the same stake, 42.5 earned. Rate 0, the reserve holds 5,000: claim now.
  state.oldPos = { ...state.pos, refetchAll: vi.fn() };
  state.oldPool = { ...state.pool, refetch: vi.fn() };
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
  window.history.replaceState({}, '', '/');
});

describe('Dashboard, beta over', () => {
  it('tells a wallet with a v1 stake where v1 stands', () => {
    renderTab(/positions/i);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE['claim-now']);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
  });

  it("a v1 pause is said in the notice, and does not disarm the new contract's Claim", () => {
    state.oldPos = { ...state.oldPos, isPaused: true };
    renderTab(/positions/i);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE.paused);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
  });

  it('a read pause on the new contract disarms its Claim', () => {
    state.pos = { ...state.pos, isPaused: true };
    renderTab(/positions/i);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeDisabled();
  });

  it('the Rewards tab disarms Claim during a pause too', () => {
    state.pos = { ...state.pos, isPaused: true };
    renderTab(/rewards/i);
    expect(screen.getByRole('button', { name: /claim staking rewards/i })).toBeDisabled();
  });

  it('a wallet with nothing anywhere is invited to stake on the new contract, with no v1 notice', () => {
    const none = { hasPosition: false, stakedFormatted: '0', pendingFormatted: '0', pendingReward: 0n };
    state.pos = { ...state.pos, ...none };
    state.oldPos = { ...state.oldPos, ...none };
    renderTab(/positions/i);
    expect(screen.getByRole('link', { name: /start staking/i })).toHaveAttribute('href', '/earn/toweli');
    expect(screen.queryByTestId('staking-beta-over')).toBeNull();
  });

  it('an IOU left on v1, with no position there, still gets the notice', () => {
    state.oldPos = {
      ...state.oldPos, hasPosition: false, stakedFormatted: '0', pendingFormatted: '0', pendingReward: 0n,
      unsettledRewards: 12n * E18, unsettledFormatted: '12',
    };
    renderTab(/positions/i);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE['claim-now']);
    expect(screen.getByTestId('old-staking-notice')).toHaveTextContent(/12 TOWELI of unsettled rewards on the old contract/i);
  });
});
