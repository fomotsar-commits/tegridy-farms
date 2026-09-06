// The logged-out dashboard's ETH-distributed tile: a fabricated zero on the
// money surface.
//
// THE BUG THIS PINS. The public strip gated the tile on `isDataLoading` alone,
// so a FAILED contract read fell straight through to
// `totalDistributed.toFixed(4)` — and the hook floors an unread total at 0n.
// A disconnected visitor met "0.0000 ETH" distributed, stated as fact, on the
// first screen, about the protocol's flagship claim. "Could not read" and
// "nothing has been paid" are different facts and must never share a rendering.
//
// The shape restored here is the one RealYieldProof.tsx already uses per call:
// skeleton while loading, an em dash plus a named reason when the read failed,
// the real figure only when the read succeeded.

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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ isDataLoading: false, isDataError: false, totalDistributed: 0 }));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: undefined,
    isConnected: false,
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
  useAutoRefreshBoost: () => ({ needsRefresh: false, effectiveBalance: 0n, rawBalance: 0n }),
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
    totalDistributed: state.totalDistributed,
    isDataLoading: state.isDataLoading,
    isDataError: state.isDataError,
    referralEarned: 0, referralPending: 0, referralPendingBig: 0n,
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

function mount() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.isDataLoading = false;
  state.isDataError = false;
  state.totalDistributed = 0;
});


/**
 * ⚠️ THIS FILE STANDS INSIDE THE TOWELI BUNGALOW, EXPLICITLY, AS OF 2026-09-05.
 *
 * It renders the CLASSIC TOWELI surface, and until now it got there by
 * accident: the page's wrapper branched on `getActiveBungalow()` /
 * `getBungalowIdentity()`, both of which are null when NOTHING is chosen, so
 * "no bungalow" and "the TOWELI bungalow" fell into the same branch. A test that
 * set nothing therefore rendered the TOWELI page — and so did a stranger
 * arriving at the venue, which was the bug (one resident's ticker, ~30 times,
 * on a page the venue was supposed to be speaking on).
 *
 * The wrapper now uses `isToweliVoice()` (arrival.ts), which separates the two.
 * So this file says where it is standing instead of relying on a collapsed
 * state. Real storage, not a mocked gate — that keeps the assertions pointed at
 * the SAME predicate the app runs, so if the gate changes shape again these
 * fail rather than quietly testing a stub.
 */

// The venue speaks for the whole island; the classic TOWELI stack lives in its
// own room. Stand in that room before rendering.
beforeEach(() => {
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('logged-out ETH Distributed tile', () => {
  it('never prints a figure when the read FAILED', () => {
    state.isDataError = true;
    mount();
    expect(screen.getByText('ETH Distributed')).toBeTruthy();
    // The fabricated zero, gone. Any digits at all would be a claim we did not
    // read, so the assertion is on the whole tile, not just "0.0000 ETH".
    expect(screen.queryByText(/[0-9.]+ ETH/)).toBeNull();
    expect(screen.getByText('read unavailable')).toBeTruthy();
  });

  it('prints a real zero when the read SUCCEEDED and the total is zero', () => {
    // The other half of the invariant: an honest zero must survive. A fix that
    // hid the tile whenever it read 0 would pass the test above and be wrong.
    mount();
    expect(screen.getByText('0.0000 ETH')).toBeTruthy();
    expect(screen.queryByText('read unavailable')).toBeNull();
  });

  it('prints the real figure when the read succeeded', () => {
    state.totalDistributed = 1.2345;
    mount();
    expect(screen.getByText('1.2345 ETH')).toBeTruthy();
  });

  it('shows neither a figure nor a failure while the read is still in flight', () => {
    state.isDataLoading = true;
    mount();
    expect(screen.queryByText(/[0-9.]+ ETH/)).toBeNull();
    expect(screen.queryByText('read unavailable')).toBeNull();
  });
});
