/**
 * TOWELI staking v1 is closing (owner, 2026-10-30). FarmPage's half: the phase it
 * reads off the chain and hands the staking card, the notice a visitor with no
 * wallet sees, and the receipt a confirmed withdrawal gets (the paused exit had
 * none). The card itself is StakingCard.betaOver.test's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type Log } from 'viem';
import { TEGRIDY_STAKING_ADDRESS } from '../lib/constants';
import { BETA_OVER_LINE } from '../lib/stakingBetaOver';

const E18 = 10n ** 18n;

const hooks = vi.hoisted(() => ({
  isConnected: true,
  pool: {} as Record<string, unknown>,
  pos: {} as Record<string, unknown>,
  actions: {} as Record<string, unknown>,
  showReceipt: vi.fn(),
  poolRefetch: vi.fn(),
  /** Captured from the last StakingCard render. */
  card: null as null | {
    betaOver?: { phase: string; onRetry?: () => void };
    lastActionRef: { current: string | null };
    submittedAmountRef: { current: string | null };
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: hooks.isConnected ? '0x1111111111111111111111111111111111111111' : undefined, isConnected: hooks.isConnected }),
  useChainId: () => 1,
}));
vi.mock('../hooks/useAutoRefreshBoost', () => ({ useAutoRefreshBoost: () => ({ needsRefresh: false }) }));
vi.mock('../hooks/useOneClickStake', () => ({ useOneClickStake: () => ({ canBatch: false, stakeOneClick: vi.fn() }) }));
vi.mock('../hooks/useLPFarming', () => ({
  useLPFarming: () => ({ refreshBoost: vi.fn(), isPending: false, isConfirming: false, periodFinish: undefined, periodFinishUnread: false }),
}));
vi.mock('../hooks/useFarmActions', () => ({ useFarmActions: () => hooks.actions }));
vi.mock('../hooks/useUserPosition', () => ({ useUserPosition: () => hooks.pos }));
vi.mock('../hooks/usePoolData', () => ({ usePoolData: () => hooks.pool }));
vi.mock('../hooks/useFarmStats', () => ({ useFarmStats: () => ({ rewardPool: '0', dailyEmissions: '0' }) }));
vi.mock('../hooks/useNFTBoost', () => ({ useNFTBoost: () => ({ holdsJBAC: false, boostLabel: null }) }));
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPrice: () => ({ priceInUsd: 0, ethUsd: 0, isLoaded: false }) }));
vi.mock('../hooks/usePriceHistory', () => ({ usePriceHistory: () => ({ history: [], error: null, isLoading: false }) }));
vi.mock('../hooks/useTransactionReceipt', () => ({ useTransactionReceipt: () => ({ showReceipt: hooks.showReceipt }) }));
vi.mock('../hooks/useConfetti', () => ({ useConfetti: () => ({ fire: vi.fn() }) }));
vi.mock('../hooks/usePoolTVL', () => ({ usePoolTVL: () => ({ stakerSharePct: 0, isLoaded: false, tvl: 0, lpSupply: 0n }) }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));
vi.mock('../hooks/useAutoReset', () => ({ useAutoReset: () => undefined }));

vi.mock('../components/farm/FarmStatsRow', () => ({ FarmStatsRow: () => null }));
vi.mock('../components/farm/IncentivesStrip', () => ({ IncentivesStrip: () => null }));
vi.mock('../components/RealYieldProof', () => ({ RealYieldProof: () => null }));
vi.mock('../components/farm/LPFarmingSection', () => ({ LPFarmingSection: () => null }));
vi.mock('../components/farm/LegacyStakingExit', () => ({ LegacyStakingExit: () => null }));
vi.mock('../components/farm/BoostScheduleTable', () => ({ BoostScheduleTable: () => null }));
vi.mock('../components/farm/LivePoolCard', () => ({ LivePoolCard: () => null }));
vi.mock('../components/farm/UpcomingPoolCard', () => ({ UpcomingPoolCard: () => null }));
vi.mock('../components/farm/poolConfig', () => ({ UPCOMING_POOLS: [] }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ui/CardArt', () => ({ CardArt: () => null }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));
vi.mock('../components/ui/ConnectPrompt', () => ({
  ConnectPrompt: ({ description }: { description?: string }) => <p data-testid="connect-prompt">{description}</p>,
}));
vi.mock('../components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/farm/StakingCard', () => ({
  StakingCard: (props: NonNullable<typeof hooks.card>) => {
    hooks.card = props;
    return null;
  },
}));

import FarmPage from './FarmPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

const EXIT_ABI = parseAbi(['event EmergencyWithdraw(address indexed user, uint256 indexed tokenId, uint256 amount)']);
function emergencyWithdrawLog(amount: bigint): Log {
  const topics = encodeEventTopics({
    abi: EXIT_ABI, eventName: 'EmergencyWithdraw', args: { user: '0x1111111111111111111111111111111111111111', tokenId: 7n },
  });
  return {
    address: TEGRIDY_STAKING_ADDRESS as Hex, topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  };
}

const page = () => (
  <MemoryRouter initialEntries={['/earn/toweli']}>
    <Routes>
      <Route path="/earn/:poolId" element={<FarmPage />} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
  hooks.isConnected = true;
  hooks.card = null;
  hooks.showReceipt.mockReset();
  hooks.poolRefetch.mockReset();
  // Every read landed: the rate still runs, the reserve holds 5,000 TOWELI, not paused.
  hooks.pool = {
    apr: '0', aprNum: 0, isDeployed: true, isDry: false, secondsRemaining: 0,
    rewardsRemaining: '5000', rewardsRemainingRaw: 5000n * E18, rewardsRemainingUnread: false,
    rewardRateRaw: E18, rewardRateUnread: false, paused: false, isLoading: false, refetch: hooks.poolRefetch,
  };
  hooks.pos = {
    allowance: 0n, refetchAll: vi.fn(), pendingFormatted: '42.5', pendingReward: 425n * E18 / 10n,
    stakedFormatted: '1000', hasPosition: true, positionUnread: false, isPaused: false, isLoading: false,
  };
  hooks.actions = { approve: vi.fn(), stake: vi.fn(), isSuccess: false, hash: undefined, receipt: undefined };
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('FarmPage hands the staking card the phase the chain reports', () => {
  it('rate still running: closing', () => {
    render(page());
    expect(hooks.card?.betaOver?.phase).toBe('closing');
  });

  it('rate 0, reserve above what this wallet is owed: claim now', () => {
    hooks.pool = { ...hooks.pool, rewardRateRaw: 0n };
    render(page());
    expect(hooks.card?.betaOver?.phase).toBe('claim-now');
  });

  it("the wallet's pause read makes it paused", () => {
    hooks.pos = { ...hooks.pos, isPaused: true };
    render(page());
    expect(hooks.card?.betaOver?.phase).toBe('paused');
  });

  it('an unread rate is unread, and its retry re-reads the pool', () => {
    hooks.pool = { ...hooks.pool, rewardRateUnread: true };
    render(page());
    expect(hooks.card?.betaOver?.phase).toBe('unread');
    hooks.card?.betaOver?.onRetry?.();
    expect(hooks.poolRefetch).toHaveBeenCalled();
  });
});

describe('FarmPage, no wallet: the notice and the connect card say v1 is closing', () => {
  it('shows the phase line from the pool reads, including the pause', () => {
    hooks.isConnected = false;
    hooks.pool = { ...hooks.pool, paused: true };
    render(page());
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE.paused);
    expect(screen.getByTestId('connect-prompt')).toHaveTextContent(/takes no new stakes/i);
  });

  it('an unread pool says so and offers a retry', () => {
    hooks.isConnected = false;
    hooks.pool = { ...hooks.pool, paused: null };
    render(page());
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE.unread);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(hooks.poolRefetch).toHaveBeenCalled();
  });
});

describe('FarmPage: a confirmed withdrawal gets a receipt of what came back', () => {
  /** Submits as the card does (tag + snapshot), then confirms with `receipt`. */
  function confirmExit(receipt: { logs: Log[] } | undefined, snapshot: string) {
    const { rerender } = render(page());
    hooks.card!.lastActionRef.current = 'unstake';
    hooks.card!.submittedAmountRef.current = snapshot;
    hooks.actions = { ...hooks.actions, isSuccess: true, hash: `0x${'ab'.repeat(32)}`, receipt };
    rerender(page());
  }

  it('reads the amount off the paused exit log, not the snapshot', () => {
    confirmExit({ logs: [emergencyWithdrawLog(1000n * E18)] }, '1');
    expect(hooks.showReceipt).toHaveBeenCalledWith(expect.objectContaining({
      type: 'unstake',
      data: expect.objectContaining({ amount: '1000', token: 'TOWELI' }),
    }));
  });

  it('falls back to the snapshot when the receipt holds no log it can read', () => {
    confirmExit(undefined, '999');
    expect(hooks.showReceipt).toHaveBeenCalledWith(expect.objectContaining({
      type: 'unstake',
      data: expect.objectContaining({ amount: '999' }),
    }));
  });
});
