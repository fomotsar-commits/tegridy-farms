/**
 * The dashboard on an empty TOWELI reward reserve: a claim there confirms and pays 0, so each
 * Claim button is described by the staking card's own sentence, and Towelie's nudge to claim
 * stays silent. What is owed is cut, never rounded up, on the button and in the nudge; the
 * boost is a multiplier, so it keeps its rounding to the nearest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  pos: {} as Record<string, unknown>,
  pool: {} as Record<string, unknown>,
  say: vi.fn(),
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

vi.mock('../hooks/useUserPosition', () => ({ useUserPosition: () => state.pos }));
vi.mock('../hooks/usePoolData', () => ({ usePoolData: () => state.pool }));
vi.mock('../hooks/useFarmActions', () => ({
  useFarmActions: () => ({ claim: vi.fn(), isPending: false, isConfirming: false, isSuccess: false, hash: undefined, pendingEth: 0n }),
}));
vi.mock('../hooks/useNFTBoost', () => ({
  useNFTBoost: () => ({ holdsJBAC: false, holdsGoldCard: false, boostLabel: '', boostMultiplier: 1 }),
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
vi.mock('../hooks/useTowelie', () => ({ useTowelie: () => ({ say: state.say }) }));

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
import { RESERVE_EMPTY_COPY } from '../lib/stakingClaimPaid';

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
  state.say.mockClear();
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
  window.history.replaceState({}, '', '/dashboard');
  // 1,000 TOWELI staked, 42.509 owed.
  state.pos = {
    hasPosition: true, positionUnread: false, isPaused: false, isLoading: false, tokenId: 7n,
    stakedFormatted: '1000', pendingFormatted: '42.509', pendingReward: 42_509n * E18 / 1000n, pendingLive: 42.509,
    accrualPerSec: 0, unsettledRewards: 0n, unsettledFormatted: '0', allowance: 0n, boostMultiplier: 1,
    isLocked: true, lockEnd: Math.floor(Date.now() / 1000) + 40 * 86_400, autoMaxLock: false, refetchAll: vi.fn(),
  };
  state.pool = {
    apr: '0', aprNum: 0, isDeployed: true, isDry: true, secondsRemaining: 0, aprDisclaimer: null,
    totalStaked: '0', rewardRateRaw: 0n, rewardRateUnread: false, rewardsRemaining: '0',
    rewardsRemainingRaw: 0n, rewardsRemainingUnread: false, paused: false, isLoading: false, refetch: vi.fn(),
  };
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
  window.history.replaceState({}, '', '/');
});

describe('Dashboard Claim on an empty reward reserve', () => {
  it('is the staking card\'s own sentence, word for word', () => {
    expect(RESERVE_EMPTY_COPY).toBe('Reserve empty: nothing accrues, and a claim pays 0 until it is refilled.');
  });

  it('Positions: the button stays, and says before the press that a claim pays 0', () => {
    renderTab(/positions/i);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
    expect(screen.getByTestId('claim-reserve-empty')).toHaveTextContent(RESERVE_EMPTY_COPY);
  });

  it('Rewards: the button stays, and says the same', () => {
    renderTab(/rewards/i);
    expect(screen.getByRole('button', { name: /claim staking rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
    expect(screen.getByTestId('claim-reserve-empty')).toHaveTextContent(RESERVE_EMPTY_COPY);
  });

  it('a funded reserve says nothing of the kind, at either button', () => {
    state.pool = { ...state.pool, isDry: false, rewardsRemaining: '5000', rewardsRemainingRaw: 5000n * E18 };
    renderTab(/positions/i);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
    expect(screen.queryByTestId('claim-reserve-empty')).toBeNull();
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).not.toHaveAttribute('aria-describedby');
    fireEvent.click(screen.getByRole('tab', { name: /rewards/i }));
    expect(screen.getByRole('button', { name: /claim staking rewards \(42\.50 TOWELI\)/i })).toBeEnabled();
    expect(screen.queryByTestId('claim-reserve-empty')).toBeNull();
  });

  it('each Claim button is described by the sentence while it is shown', () => {
    renderTab(/positions/i);
    expect(screen.getByRole('button', { name: /claim rewards \(42\.50 TOWELI\)/i })).toHaveAccessibleDescription(RESERVE_EMPTY_COPY);
    fireEvent.click(screen.getByRole('tab', { name: /rewards/i }));
    expect(screen.getByRole('button', { name: /claim staking rewards \(42\.50 TOWELI\)/i })).toHaveAccessibleDescription(RESERVE_EMPTY_COPY);
  });

  // A money warning over the page art: on the stat strip's dark plate, in amber at 12px, under both buttons.
  it('sits on a dark plate in amber under each Claim button, never bare grey text on the art', () => {
    const onPlate = (id: string) => {
      const line = screen.getByTestId('claim-reserve-empty');
      expect(line).toHaveAttribute('id', id);
      expect(line).toHaveClass('text-amber-200', 'text-[12px]', 'rounded-lg');
      expect(line).not.toHaveClass('text-white/70');
      expect(line).toHaveStyle({ backgroundColor: 'rgba(0, 0, 0, 0.78)', borderColor: 'rgba(245, 158, 11, 0.25)' });
    };
    renderTab(/positions/i);
    onPlate('claim-reserve-empty-positions');
    fireEvent.click(screen.getByRole('tab', { name: /rewards/i }));
    onPlate('claim-reserve-empty-rewards');
  });
});

describe("Towelie's nudge to claim", () => {
  const nudges = () => state.say.mock.calls.map((c) => String(c[0])).filter((t) => /waiting\. Claim it\./.test(t));

  it('names what is owed cut, as the button does, on a funded reserve', () => {
    state.pool = { ...state.pool, isDry: false, rewardsRemaining: '5000', rewardsRemainingRaw: 5000n * E18 };
    renderTab(/positions/i);
    expect(nudges()).toEqual(["You've got 42.50 TOWELI waiting. Claim it."]);
  });

  it('is silent on an empty reserve, where a claim pays 0', () => {
    renderTab(/positions/i);
    expect(nudges()).toEqual([]);
  });

  it('is silent until the reserve has been read', () => {
    state.pool = { ...state.pool, isDry: false, rewardsRemainingUnread: true };
    renderTab(/positions/i);
    expect(nudges()).toEqual([]);
  });
});

describe('the Positions boost', () => {
  it('is a multiplier, so it is rounded to the nearest, not cut', () => {
    state.pos = { ...state.pos, boostMultiplier: 3.996 };
    renderTab(/positions/i);
    expect(screen.getByText('Boost').nextElementSibling?.textContent).toBe('4.00x');
  });
});
