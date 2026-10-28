/**
 * EMPTY REWARD RESERVE — what the exits say when TegridyStaking cannot pay.
 *
 * Read off the deployed contract on a mainnet fork, 2026-10-27, with the reserve
 * empty (balance == totalStaked, IOU cap full):
 *   - earlyWithdraw pays rewards from the reserve, then BURNS the position, so the
 *     unpaid part is forfeited for good (position #12: 391,192 TOWELI, no IOU).
 *     The confirm said only "You will receive: <75% of principal>".
 *   - the expired-lock pause exit (emergencyExitPosition) pays 0 and books the
 *     rewards as Unsettled. The confirm said it "pays the rewards it has earned".
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

type CardProps = ComponentProps<typeof StakingCard>;
type Pool = NonNullable<CardProps['pool']>;

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
/** 42.5 TOWELI owed. */
const EARNED_WEI = 425n * 10n ** 17n;
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
const DRY: Pool = { apr: '0', aprNum: 0, isDeployed: true, isDry: true, rewardsRemaining: '0', rewardsRemainingUnread: false };

function Harness({ pool }: { pool: Pool }) {
  const pos = useUserPosition();
  const [confirms, setConfirms] = useState<ConfirmState>(CLOSED);
  return (
    <StakingCard
      isConnected pos={pos} confirms={confirms} pool={pool}
      setConfirm={(k, v) => setConfirms((p) => ({ ...p, [k]: v }))}
      actions={actions as unknown as CardProps['actions']}
      nft={{ holdsJBAC: false } as unknown as CardProps['nft']}
      input={{
        amount: '', setAmount: noop, lock: LOCK_OPTIONS[0]!, setLock: noop,
        extendLockDuration: LOCK_OPTIONS[0]!, setExtendLockDuration: noop,
      }}
      computed={{ boostDisplay: '2.00', totalBoostBps: 20_000, amtNum: 0, effectiveStake: 0, stakeNeedsApproval: false }}
      handleStake={noop} lastActionRef={{ current: null }} submittedAmountRef={{ current: null }}
    />
  );
}

function stubStaker({ expired, paused, rate = 0n }: { expired: boolean; paused: boolean; rate?: bigint }) {
  const now = Math.floor(Date.now() / 1000);
  const lockEnd = expired ? now - 86_400 : now + 40 * 86_400;
  wagmiMock.setReadResult({ functionName: 'userTokenId', result: 7n });
  wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n });
  wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
  wagmiMock.setReadResult({ functionName: 'unsettledRewards', result: 0n });
  wagmiMock.setReadResult({ functionName: 'rewardRate', result: rate });
  wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 10n ** 24n });
  wagmiMock.setReadResult({
    functionName: 'getPosition',
    result: [1000n * 10n ** 18n, 20_000n, BigInt(lockEnd), BigInt(90 * 86_400), false, expired],
  });
  wagmiMock.setReadResult({ functionName: 'earned', result: EARNED_WEI });
  wagmiMock.setReadResult({ functionName: 'paused', result: paused });
}

function openEarlyExit(pool: Pool) {
  stubStaker({ expired: false, paused: false });
  renderWithProviders(<Harness pool={pool} />);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(PENALTY_COPY.earlyExitLabel, 'i') }));
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  vi.clearAllMocks();
});

describe('StakingCard — early withdraw on a reserve that cannot pay', () => {
  it('quotes the unpaid rewards the exit destroys', () => {
    // OLD: the confirm quoted the penalty and the principal back, nothing else.
    openEarlyExit(DRY);
    expect(screen.getByTestId('early-exit-reward-loss'))
      .toHaveTextContent(/lose up to 42\.5\d* TOWELI of unpaid rewards for good/i);
  });

  it('quotes only the part a partly-funded reserve cannot cover', () => {
    openEarlyExit({ ...DRY, isDry: false, rewardsRemaining: '40' });
    expect(screen.getByTestId('early-exit-reward-loss')).toHaveTextContent(/lose up to 2\.5\d* TOWELI/i);
  });

  it('says nothing about a loss when the reserve covers what is owed', () => {
    openEarlyExit({ ...DRY, isDry: false, rewardsRemaining: '1000' });
    expect(screen.queryByTestId('early-exit-reward-loss')).toBeNull();
  });

  it('an unread reserve gives the rule, never a figure', () => {
    // The '0' usePoolData returns for an unread reserve is a display default: read
    // as a real zero it would quote the whole 42.5 as lost.
    openEarlyExit({ ...DRY, isDry: false, rewardsRemainingUnread: true });
    const line = screen.getByTestId('early-exit-reward-loss');
    expect(line).toHaveTextContent(/can't cover are lost for good/i);
    expect(line).not.toHaveTextContent(/\d/);
  });
});

describe('StakingCard — Claimable on an empty reserve', () => {
  // rewardRate stays non-zero on chain when the reserve empties, so the position
  // hook still derives a per-second rate. Mainnet, 2026-10-27: "+0.045946/s".
  const RATE = 824_300_000_000_000_000n;

  it('shows no per-second accrual, and says why', () => {
    // OLD: "est. live · +0.045946/s" beside a pinned counter.
    stubStaker({ expired: false, paused: false, rate: RATE });
    renderWithProviders(<Harness pool={DRY} />);
    expect(screen.queryByText(/est\. live/i)).toBeNull();
    expect(screen.getByTestId('claimable-reserve-empty')).toHaveTextContent(/nothing accrues/i);
  });

  it('keeps the live estimate on a funded reserve', () => {
    stubStaker({ expired: false, paused: false, rate: RATE });
    renderWithProviders(<Harness pool={{ ...DRY, isDry: false, rewardsRemaining: '1000' }} />);
    expect(screen.getByText(/est\. live/i)).toBeInTheDocument();
    expect(screen.queryByTestId('claimable-reserve-empty')).toBeNull();
  });
});

describe('StakingCard — paused, lock ended, reserve empty', () => {
  it('does not promise to pay rewards the reserve cannot pay', () => {
    // OLD: "Withdraws your 1000 TOWELI and pays the rewards it has earned".
    stubStaker({ expired: true, paused: true });
    renderWithProviders(<Harness pool={DRY} />);
    fireEvent.click(screen.getByRole('button', { name: /withdraw \+ claim/i }));
    const confirm = screen.getByTestId('staking-pause-exit-confirm');
    expect(confirm).toHaveTextContent(/stay owed as Unsettled/i);
    expect(confirm).not.toHaveTextContent(/pays the rewards/i);
  });
});
