/**
 * TOWELI staking v1 is closing (owner, 2026-10-30). What the card says and offers
 * once FarmPage hands it `betaOver`: the "Beta is over" notice, no new stake, no
 * lock extension, claim and every withdraw kept, and the paused exit tagged for a
 * withdrawal receipt.
 *
 * Renders the REAL useUserPosition over wagmi-mocks, as StakingCard.pause.test does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { StakingCard, type ConfirmState } from './StakingCard';
import { useUserPosition } from '../../hooks/useUserPosition';
import { LOCK_OPTIONS, CHAIN_ID } from '../../lib/constants';
import { PENALTY_COPY } from '../../lib/copy';
import { BETA_OVER_LINE, NEW_STAKES_CLOSED_LINE, type StakingBetaPhase } from '../../lib/stakingBetaOver';

type CardProps = ComponentProps<typeof StakingCard>;

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const TOKEN_ID = 7n;
const noop = () => {};
const actions = {
  claim: vi.fn(), claimUnsettled: vi.fn(), earlyWithdraw: vi.fn(),
  emergencyWithdraw: vi.fn(), emergencyExit: vi.fn(),
  extendLock: vi.fn(), withdraw: vi.fn(), revalidateBoost: vi.fn(), toggleAutoMaxLock: vi.fn(),
  stake: vi.fn(), approve: vi.fn(), isConfirming: false, isPending: false,
};
const CLOSED: ConfirmState = {
  withdraw: false, earlyWithdraw: false, emergencyExit: false, extendLock: false, autoMaxLock: false,
};
const lastActionRef: CardProps['lastActionRef'] = { current: null };
const submittedAmountRef: CardProps['submittedAmountRef'] = { current: null };

function Harness({ phase }: { phase?: StakingBetaPhase }) {
  const pos = useUserPosition();
  const [confirms, setConfirms] = useState<ConfirmState>(CLOSED);
  return (
    <StakingCard
      isConnected pos={pos} confirms={confirms}
      pool={{ apr: '0', aprNum: 0, isDeployed: true, isDry: false, rewardsRemaining: '5000', rewardsRemainingUnread: false }}
      setConfirm={(k, v) => setConfirms((p) => ({ ...p, [k]: v }))}
      actions={actions as unknown as CardProps['actions']}
      nft={{ holdsJBAC: false } as unknown as CardProps['nft']}
      input={{
        amount: '', setAmount: noop, lock: LOCK_OPTIONS[0]!, setLock: noop,
        extendLockDuration: LOCK_OPTIONS[0]!, setExtendLockDuration: noop,
      }}
      computed={{ boostDisplay: '2.00', totalBoostBps: 20_000, amtNum: 0, effectiveStake: 0, stakeNeedsApproval: false }}
      handleStake={noop} lastActionRef={lastActionRef} submittedAmountRef={submittedAmountRef}
      betaOver={phase ? { phase } : undefined}
    />
  );
}

/** 1,000 TOWELI staked on position #7, 42.5 TOWELI earned. */
function stubStaker({ lock, paused }: { lock: 'locked' | 'expired' | 'none'; paused: boolean }) {
  const now = Math.floor(Date.now() / 1000);
  const lockEnd = lock === 'expired' ? now - 86_400 : now + 40 * 86_400;
  wagmiMock.setReadResult({ functionName: 'userTokenId', result: lock === 'none' ? 0n : TOKEN_ID });
  wagmiMock.setReadResult({ functionName: 'balanceOf', result: 5000n * 10n ** 18n });
  wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
  wagmiMock.setReadResult({ functionName: 'unsettledRewards', result: 0n });
  wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n });
  wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 10n ** 24n });
  wagmiMock.setReadResult({ functionName: 'maxStakePerUser', result: 50_000n * 10n ** 18n });
  wagmiMock.setReadResult({
    functionName: 'getPosition',
    result: [1000n * 10n ** 18n, 20_000n, BigInt(lockEnd), BigInt(90 * 86_400), false, lock === 'expired'],
  });
  wagmiMock.setReadResult({ functionName: 'earned', result: 425n * 10n ** 17n });
  wagmiMock.setReadResult({ functionName: 'paused', result: paused });
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  vi.clearAllMocks();
  lastActionRef.current = null;
  submittedAmountRef.current = null;
});

describe('StakingCard, beta over: no new stakes into v1', () => {
  it('a wallet with no position gets the notice and the reason, not a stake form', () => {
    stubStaker({ lock: 'none', paused: false });
    renderWithProviders(<Harness phase="closing" />);
    expect(screen.getByRole('heading', { name: 'Beta is over' })).toBeInTheDocument();
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE.closing);
    expect(screen.getByTestId('staking-v1-closed')).toHaveTextContent(NEW_STAKES_CLOSED_LINE);
    expect(screen.queryByRole('textbox', { name: /amount of toweli to stake/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /stake & lock|approve toweli|enter amount/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Stake TOWELI' })).toBeNull();
  });

  it('without betaOver (the next contract) the stake form is untouched', () => {
    stubStaker({ lock: 'none', paused: false });
    renderWithProviders(<Harness />);
    expect(screen.getByRole('textbox', { name: /amount of toweli to stake/i })).toBeInTheDocument();
    expect(screen.queryByTestId('staking-beta-over')).toBeNull();
  });

  it('a position keeps Claim and the exits, and loses Extend Lock and Auto-Max Lock', () => {
    stubStaker({ lock: 'locked', paused: false });
    renderWithProviders(<Harness phase="claim-now" />);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE['claim-now']);
    expect(screen.getByRole('button', { name: /^claim rewards$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: new RegExp(PENALTY_COPY.earlyExitLabel, 'i') })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /extend lock/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /enable auto-max lock/i })).toBeNull();
    expect(screen.getByTestId('extend-lock-closed')).toHaveTextContent(/extensions closed/i);
  });

  it('the early-exit confirm says the pause will give the stake back free, and snapshots what comes back', () => {
    stubStaker({ lock: 'locked', paused: false });
    renderWithProviders(<Harness phase="closing" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(PENALTY_COPY.earlyExitLabel, 'i') }));
    expect(screen.getByTestId('early-exit-wait-for-pause')).toHaveTextContent(/once v1 pauses.*no penalty/i);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`pay the ${PENALTY_COPY.earlyExitLabel}`, 'i') }));
    expect(actions.earlyWithdraw).toHaveBeenCalledWith(TOKEN_ID);
    // 1,000 staked, 25% to the treasury: the fallback receipt figure is the 750 returned.
    expect(submittedAmountRef.current).toBe('750');
  });
});

describe('StakingCard, beta over: the paused withdraw', () => {
  it('a locked stake exits through emergencyWithdrawPosition, its confirm states the trade, and it is tagged for a receipt', () => {
    stubStaker({ lock: 'locked', paused: true });
    renderWithProviders(<Harness phase="paused" />);
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE.paused);
    // The notice replaces the old "until it is unpaused" banner.
    expect(screen.queryByTestId('staking-paused')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^emergency withdraw \(forfeits rewards\)$/i }));
    const panel = screen.getByTestId('staking-pause-exit-confirm');
    expect(panel).toHaveTextContent(/returns your full 1000 TOWELI with no early-exit penalty/i);
    expect(panel).toHaveTextContent(/forfeits your unclaimed rewards \(currently 42\.5\d* TOWELI\)/i);

    fireEvent.click(screen.getByRole('button', { name: /confirm emergency withdraw/i }));
    expect(actions.emergencyWithdraw).toHaveBeenCalledWith(TOKEN_ID);
    expect(actions.emergencyExit).not.toHaveBeenCalled();
    // OLD: tagged null, so a confirmed exit showed no receipt at all.
    expect(lastActionRef.current).toBe('unstake');
    expect(submittedAmountRef.current).toBe('1000');
  });

  it('an ended lock exits through emergencyExitPosition, which pays its rewards, also tagged for a receipt', () => {
    stubStaker({ lock: 'expired', paused: true });
    renderWithProviders(<Harness phase="paused" />);
    fireEvent.click(screen.getByRole('button', { name: /withdraw \+ claim/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm withdraw \+ claim/i }));
    expect(actions.emergencyExit).toHaveBeenCalledWith(TOKEN_ID);
    expect(actions.emergencyWithdraw).not.toHaveBeenCalled();
    expect(lastActionRef.current).toBe('unstake');
  });
});
