/**
 * The early-withdraw confirm's two figures, from the contract's own split (TegridyStaking.sol:1554,
 * penalty = amount * 2500 / 10000, rounded down): "Penalty: X TOWELI" is paid, so it is rounded UP;
 * "You will receive: X TOWELI" comes back, so it is CUT; together they never read below the stake.
 * The Boost is a multiplier, not an amount, so it keeps its rounding to the nearest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { StakingCard, type ConfirmState } from './StakingCard';
import { useUserPosition } from '../../hooks/useUserPosition';
import { LOCK_OPTIONS, CHAIN_ID } from '../../lib/constants';
import { PENALTY_COPY } from '../../lib/copy';

type CardProps = ComponentProps<typeof StakingCard>;
type Pool = NonNullable<CardProps['pool']>;

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
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
const FUNDED: Pool = { apr: '0', aprNum: 0, isDeployed: true, isDry: false, rewardsRemaining: '1000000', rewardsRemainingUnread: false };

function Harness() {
  const pos = useUserPosition();
  const [confirms, setConfirms] = useState<ConfirmState>(CLOSED);
  return (
    <StakingCard
      isConnected pos={pos} confirms={confirms} pool={FUNDED}
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

/** The chain reads of one locked position of `stakedWei`, boosted `boostBps`. */
function positionReads(stakedWei: bigint, boostBps = 20_000n) {
  const lockEnd = Math.floor(Date.now() / 1000) + 40 * 86_400;
  wagmiMock.setReadResult({ functionName: 'userTokenId', result: 7n });
  wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n });
  wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
  wagmiMock.setReadResult({ functionName: 'unsettledRewards', result: 0n });
  wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n });
  wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 10n ** 24n });
  wagmiMock.setReadResult({ functionName: 'getPosition', result: [stakedWei, boostBps, BigInt(lockEnd), BigInt(90 * 86_400), false, false] });
  wagmiMock.setReadResult({ functionName: 'earned', result: 0n });
  wagmiMock.setReadResult({ functionName: 'paused', result: false });
}

/** The confirm's two figures, in hundredths of a TOWELI, for a stake of `stakedWei`. */
function confirmFor(stakedWei: bigint): { penalty: bigint; receive: bigint; text: string } {
  positionReads(stakedWei);
  renderWithProviders(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(PENALTY_COPY.earlyExitLabel, 'i') }));
  const text = document.body.textContent ?? '';
  const cents = (re: RegExp) => BigInt(re.exec(text)![1]!.replace('.', ''));
  return { penalty: cents(/Penalty: (\d+\.\d\d) TOWELI/), receive: cents(/You will receive: (\d+\.\d\d) TOWELI/), text };
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  vi.clearAllMocks();
});

describe('StakingCard: the early-withdraw figures', () => {
  it('rounds the penalty up and cuts what comes back: 100.0098 staked is 25.01 and 75.00', () => {
    const { penalty, receive } = confirmFor(100_009_800n * 10n ** 12n);
    expect(penalty).toBe(2501n);
    expect(receive).toBe(7500n);
  });

  it('over many stakes: the penalty never reads low, what comes back never reads high, and the two cover the stake as printed', () => {
    for (const stakedWei of [100n * 10n ** 18n, 100_019_800n * 10n ** 12n, 123_456_789_123_456_789_123n, 1_000_000_000_000_000_001n * 100n, 391_192_999_999_999_999_999_999n]) {
      const { penalty, receive, text } = confirmFor(stakedWei);
      const penaltyWei = (stakedWei * 2500n) / 10_000n;
      const cent = 10n ** 16n;
      expect(penalty * cent, text).toBeGreaterThanOrEqual(penaltyWei);
      expect(penalty * cent - penaltyWei, text).toBeLessThan(cent);
      expect(receive * cent, text).toBeLessThanOrEqual(stakedWei - penaltyWei);
      expect(stakedWei - penaltyWei - receive * cent, text).toBeLessThan(cent);
      expect(penalty + receive, text).toBeGreaterThanOrEqual(stakedWei / cent);
      cleanup();
    }
  });
});

describe('StakingCard: the Boost', () => {
  it('a 3.996x boost reads 4.00x, not 3.99x', () => {
    positionReads(1_000n * 10n ** 18n, 39_960n);
    renderWithProviders(<Harness />);
    expect(screen.getByText('Boost').nextElementSibling?.textContent).toBe('4.00x');
  });
});
