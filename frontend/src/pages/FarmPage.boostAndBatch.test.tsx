// What the Farm page does with the two hooks that used to be mounted nowhere.
//
// Reachability is pinned by hooksAreMounted.test.ts; this pins BEHAVIOUR at the
// mount point, which is where a wiring mistake actually costs a user money:
//
//   1. A stale LP boost has to be visible and fixable HERE. The farm recomputes
//      the boost only inside stake/withdraw/exit, so a wallet that staked before
//      buying its JBAC earns at the unboosted rate until someone tells it.
//   2. The EIP-5792 path must never be taken on a wallet that has not advertised
//      support, and the CTA must describe the confirmation the user is about to
//      sign — "Approve TOWELI" in front of a prompt that also stakes is a lie
//      about what is being authorised.
//
// The child components are stubbed: this file is about the page's decisions, and
// StakingCard's own rendering is not on trial here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const hooks = vi.hoisted(() => ({
  needsRefresh: false,
  canBatch: false,
  refreshBoost: vi.fn(),
  stakeOneClick: vi.fn(),
  approve: vi.fn(),
  stake: vi.fn(),
  allowance: 0n,
  /** Captured from the last StakingCard render. */
  lastComputed: null as null | { stakeNeedsApproval: boolean },
  lastHandleStake: null as null | (() => void),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true }),
  useChainId: () => 1,
}));

vi.mock('../hooks/useAutoRefreshBoost', () => ({
  useAutoRefreshBoost: () => ({ needsRefresh: hooks.needsRefresh, effectiveBalance: 0n, rawBalance: 0n }),
}));

vi.mock('../hooks/useOneClickStake', () => ({
  useOneClickStake: () => ({ canBatch: hooks.canBatch, stakeOneClick: hooks.stakeOneClick }),
}));

vi.mock('../hooks/useLPFarming', () => ({
  useLPFarming: () => ({ refreshBoost: hooks.refreshBoost, isPending: false, isConfirming: false }),
}));

vi.mock('../hooks/useFarmActions', () => ({
  useFarmActions: () => ({
    approve: hooks.approve,
    stake: hooks.stake,
    isSuccess: false,
    hash: undefined,
  }),
}));

vi.mock('../hooks/useUserPosition', () => ({
  useUserPosition: () => ({
    allowance: hooks.allowance,
    refetchAll: vi.fn(),
    pendingFormatted: '0',
    stakedFormatted: '0',
    hasPosition: false,
  }),
}));

vi.mock('../hooks/useFarmStats', () => ({ useFarmStats: () => ({ rewardPool: '0', dailyEmissions: '0' }) }));
vi.mock('../hooks/usePoolData', () => ({
  usePoolData: () => ({ apr: '0', aprNum: 0, isDeployed: false, rewardsRemaining: '0', secondsRemaining: 0 }),
}));
vi.mock('../hooks/useNFTBoost', () => ({
  useNFTBoost: () => ({ holdsJBAC: true, holdsGoldCard: false, boostLabel: 'JBAC +0.5x', boostMultiplier: 1.5 }),
}));
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPrice: () => ({ priceInUsd: 0, ethUsd: 0, isLoaded: false }) }));
vi.mock('../hooks/usePriceHistory', () => ({ usePriceHistory: () => ({ history: [], error: null, isLoading: false }) }));
vi.mock('../hooks/useTransactionReceipt', () => ({ useTransactionReceipt: () => ({ showReceipt: vi.fn() }) }));
vi.mock('../hooks/useConfetti', () => ({ useConfetti: () => ({ fire: vi.fn() }) }));
vi.mock('../hooks/usePoolTVL', () => ({ usePoolTVL: () => ({ stakerSharePct: 0, isLoaded: false, tvl: 0, lpSupply: 0n }) }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));
vi.mock('../hooks/usePoints', () => ({ usePoints: () => ({}) }));
vi.mock('../hooks/useAutoReset', () => ({ useAutoReset: () => undefined }));
vi.mock('../hooks/useRestaking', () => ({ useRestaking: () => ({ isDeployed: false, isRestaked: false, bonusAPR: 0 }) }));

vi.mock('../components/farm/FarmStatsRow', () => ({ FarmStatsRow: () => null }));
vi.mock('../components/farm/IncentivesStrip', () => ({ IncentivesStrip: () => null }));
vi.mock('../components/RealYieldProof', () => ({ RealYieldProof: () => null }));
vi.mock('../components/farm/LPFarmingSection', () => ({ LPFarmingSection: () => <div>lp farming</div> }));
vi.mock('../components/farm/LegacyStakingExit', () => ({ LegacyStakingExit: () => null }));
vi.mock('../components/farm/BoostScheduleTable', () => ({ BoostScheduleTable: () => null }));
vi.mock('../components/farm/LivePoolCard', () => ({ LivePoolCard: () => null }));
vi.mock('../components/farm/UpcomingPoolCard', () => ({ UpcomingPoolCard: () => null }));
vi.mock('../components/farm/poolConfig', () => ({ UPCOMING_POOLS: [] }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));
vi.mock('../components/ui/ConnectPrompt', () => ({ ConnectPrompt: () => null }));
vi.mock('../components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// The probe: capture the props the page hands the staking card.
vi.mock('../components/farm/StakingCard', () => ({
  StakingCard: (props: {
    computed: { stakeNeedsApproval: boolean };
    handleStake: () => void;
    input: { amount: string; setAmount: (v: string) => void };
  }) => {
    hooks.lastComputed = props.computed;
    hooks.lastHandleStake = props.handleStake;
    return (
      <>
        <input
          aria-label="stake amount"
          value={props.input.amount}
          onChange={(e) => props.input.setAmount(e.target.value)}
        />
        <button onClick={props.handleStake}>
          {props.computed.stakeNeedsApproval ? 'Approve TOWELI' : 'Stake & Lock'}
        </button>
      </>
    );
  },
}));

import FarmPage from './FarmPage';

function renderFarm() {
  return render(
    <MemoryRouter>
      <FarmPage />
    </MemoryRouter>,
  );
}

/** Type an amount, which is what makes the approve/stake branch live at all. */
function enterAmount(value = '100') {
  fireEvent.change(screen.getByLabelText('stake amount'), { target: { value } });
}

beforeEach(() => {
  hooks.needsRefresh = false;
  hooks.canBatch = false;
  hooks.allowance = 0n;
  hooks.refreshBoost.mockReset();
  hooks.stakeOneClick.mockReset().mockResolvedValue('0xbatch');
  hooks.approve.mockReset();
  hooks.stake.mockReset();
  hooks.lastComputed = null;
  hooks.lastHandleStake = null;
});

describe('stale LP boost (AUDIT F-7)', () => {
  it('says nothing when the boost is applied', () => {
    renderFarm();
    expect(screen.queryByRole('button', { name: /refresh boost/i })).toBeNull();
  });

  it('names the cause and offers the fix when the boost is stale', () => {
    hooks.needsRefresh = true;
    renderFarm();
    // The banner has to explain WHY, or it reads as a random error.
    expect(screen.getByText(/stake, withdraw or exit/i)).toBeTruthy();
    expect(screen.getByText(/unboosted rate/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /refresh boost/i }));
    expect(hooks.refreshBoost).toHaveBeenCalledTimes(1);
  });
});

describe('EIP-5792 approve+stake', () => {
  it('keeps the sequential flow on a wallet that has not advertised batching', () => {
    hooks.canBatch = false;
    renderFarm();
    enterAmount();
    expect(hooks.lastComputed?.stakeNeedsApproval).toBe(true);
    expect(screen.getByRole('button', { name: 'Approve TOWELI' })).toBeTruthy();
  });

  it('labels the CTA for the confirmation it actually produces when batching', () => {
    hooks.canBatch = true;
    renderFarm();
    enterAmount();
    // One prompt does approve AND stake, so "Approve TOWELI" would understate it.
    expect(hooks.lastComputed?.stakeNeedsApproval).toBe(false);
    expect(screen.getByRole('button', { name: 'Stake & Lock' })).toBeTruthy();
  });

  it('does not batch when no approval is needed — there is nothing to collapse', () => {
    hooks.canBatch = true;
    hooks.allowance = 10n ** 30n;
    renderFarm();
    enterAmount();
    hooks.lastHandleStake?.();
    expect(hooks.stakeOneClick).not.toHaveBeenCalled();
    expect(hooks.stake).toHaveBeenCalledTimes(1);
  });

  it('falls back to the sequential flow for the rest of the session after a real batch failure', async () => {
    hooks.canBatch = true;
    hooks.stakeOneClick.mockRejectedValue(new Error('wallet_sendCalls not supported'));
    renderFarm();
    enterAmount();

    hooks.lastHandleStake?.();
    await waitFor(() => expect(hooks.stakeOneClick).toHaveBeenCalledTimes(1));
    // Retiring the path is the point: the next click must reach the proven flow.
    await waitFor(() => expect(hooks.lastComputed?.stakeNeedsApproval).toBe(true));
    hooks.lastHandleStake?.();
    expect(hooks.stakeOneClick).toHaveBeenCalledTimes(1);
    expect(hooks.approve).toHaveBeenCalledTimes(1);
  });

  it('keeps the one-click affordance when the user simply declined', async () => {
    hooks.canBatch = true;
    hooks.stakeOneClick.mockRejectedValue(Object.assign(new Error('User rejected'), { code: 4001 }));
    renderFarm();
    enterAmount();

    hooks.lastHandleStake?.();
    await waitFor(() => expect(hooks.stakeOneClick).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hooks.lastComputed?.stakeNeedsApproval).toBe(false));
    expect(hooks.approve).not.toHaveBeenCalled();
  });
});
