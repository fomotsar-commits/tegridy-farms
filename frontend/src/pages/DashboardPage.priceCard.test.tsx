// The connected Dashboard's "TOWELI Price" card has three honest states and used to
// have one and a half.
//
// It showed a skeleton for as long as the price hook had nothing, which is forever
// when every price source fails, and it printed "$0.00000000" when the pair was read
// but could not price and the API leg had failed. A price that could not be read is
// neither still loading nor zero: once every leg has answered or failed, the card
// says so.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const price = vi.hoisted(() => ({ isLoaded: false, priceSettled: false, priceInUsd: 0, oracleStale: false }));

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
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    // The counter a read price is drawn with asks this; reduced motion prints the value at once.
    useReducedMotion: () => true,
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('../hooks/useAutoRefreshBoost', () => ({
  useAutoRefreshBoost: () => ({ needsRefresh: false, effectiveBalance: 0n, rawBalance: 0n }),
}));
vi.mock('../hooks/useLpPosition', () => ({
  useLpPosition: () => ({
    hasPosition: false, lpBalance: 0n, lpBalanceFormatted: '0', walletLp: 0n, walletLpFormatted: '0',
    stakedLp: 0n, stakedLpFormatted: '0', sharePct: 0, toweliAmount: 0, wethAmount: 0, pendingRewards: 0,
    farmingDeployed: true, isLoading: false, lpUnread: false, reservesUnread: false,
  }),
}));

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({
    priceInEth: 0, priceInUsd: price.priceInUsd, ethUsd: 0, isLoaded: price.isLoaded, priceSettled: price.priceSettled,
    oracleStale: price.oracleStale, priceChange: 0, priceUnavailable: price.priceInUsd <= 0, displayPriceStale: false,
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
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

/** The summary card whose label is "TOWELI Price". */
function priceCard(): HTMLElement {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  const card = screen
    .getAllByText('TOWELI Price')
    .map((el) => el.closest('.glass-card-animated'))
    .find((el): el is HTMLElement => el instanceof HTMLElement);
  if (!card) throw new Error('no TOWELI Price summary card on the connected Dashboard');
  return card;
}

const isBusy = (card: HTMLElement) => card.querySelector('[aria-busy="true"]') !== null;

// The classic TOWELI dashboard, where this card lives, is the TOWELI room's page.
beforeEach(() => {
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
  Object.assign(price, { isLoaded: false, priceSettled: false, priceInUsd: 0, oracleStale: false });
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('Dashboard "TOWELI Price" card', () => {
  it('shows a loading placeholder while a price source has yet to answer', () => {
    const card = priceCard();
    expect(isBusy(card)).toBe(true);
    expect(within(card).queryByText(/could not/i)).toBeNull();
  });

  it('stops loading and says the price could not be read once every source has failed', () => {
    Object.assign(price, { isLoaded: false, priceSettled: true, priceInUsd: 0 });
    const card = priceCard();
    expect(isBusy(card)).toBe(false);
    expect(within(card).getByText('Could not load')).toBeTruthy();
    expect(within(card).getByTitle('Failed to load')).toBeTruthy();
  });

  it('never prints a zero price when the pair was read but nothing could price it', () => {
    // The pair is read (isLoaded) but too thin to price, and the API leg failed.
    Object.assign(price, { isLoaded: true, priceSettled: true, priceInUsd: 0 });
    const card = priceCard();
    expect(isBusy(card)).toBe(false);
    expect(card.textContent).not.toMatch(/\$\s*0(\.0+)?(?!\d)/);
    expect(within(card).getByText('Could not load')).toBeTruthy();
  });

  it('a price that could not be read is not labelled stale', () => {
    Object.assign(price, { isLoaded: true, priceSettled: true, priceInUsd: 0, oracleStale: true });
    const card = priceCard();
    expect(within(card).queryByText('Stale')).toBeNull();
    expect(within(card).getByText('Could not load')).toBeTruthy();
  });

  it('shows the price, with no failure mark, when one was read', () => {
    Object.assign(price, { isLoaded: true, priceSettled: true, priceInUsd: 0.00007 });
    const card = priceCard();
    expect(isBusy(card)).toBe(false);
    expect(within(card).queryByText('Could not load')).toBeNull();
    expect(within(card).queryByTitle('Failed to load')).toBeNull();
    expect(card.textContent).toMatch(/\$/);
  });
});
