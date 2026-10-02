/**
 * PAUSE — StakingCard's emergency exit, and the `paused()` read it hangs on.
 *
 * Two defects on one card. Both were read off the DEPLOYED TegridyStaking
 * (0xcaDc93E96De58EA554c71ca609974625615E046D, runtime byte-identical to the
 * DeployMVP commit 833b757) on a mainnet fork before anything here changed.
 *
 * 1. THE WRONG DOOR. During a pause the card rendered "Emergency Exit (Forfeit
 *    Rewards)" and sent `emergencyExitPosition` to every staker:
 *      - LOCKED stake: emergencyExitPosition reverts LockStillActive before
 *        lockEnd, so the button could never succeed. The door that does work is
 *        `emergencyWithdrawPosition` (whenPaused; full principal, no penalty,
 *        rewards FORFEITED), and it was in no ABI and at no call site.
 *      - EXPIRED lock: emergencyExitPosition works and PAYS the rewards, so
 *        "Forfeit Rewards" / "forfeits all pending rewards" was false.
 *    NEW: the door follows on-chain `canWithdraw` (block.timestamp >= lockEnd,
 *    the exact condition emergencyExitPosition checks), and each door is named
 *    for what it does.
 *
 * 2. OUTAGE-AS-ZERO. useUserPosition collapsed an unanswered `paused()` to
 *    `false`, so an RPC hiccup during a pause HID the exit. NEW: `null` renders
 *    its own notice + Retry, arms no door, and switches nothing off.
 *
 * And while the chain REPORTS a pause, every whenNotPaused control is switched
 * off and a banner says why. An unread pause switches nothing off.
 *
 * Most of these render the REAL useUserPosition over wagmi-mocks, so the
 * hook -> card wiring is what is under test, not a hand-built `pos`. Per-test,
 * what the UNPATCHED code did is recorded in the test body.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { screen, fireEvent, within } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { StakingCard, type ConfirmState, type StakeInputState } from './StakingCard';
import { useUserPosition } from '../../hooks/useUserPosition';
import { LOCK_OPTIONS, CHAIN_ID } from '../../lib/constants';
import { PENALTY_COPY } from '../../lib/copy';

type CardProps = ComponentProps<typeof StakingCard>;
type Lock = 'locked' | 'expired';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const TOKEN_ID = 7n;
const STAKED_WEI = 1000n * 10n ** 18n;
/** 42.5 TOWELI — the figure a forfeit confirm must quote. */
const EARNED_WEI = 425n * 10n ** 17n;
const LOCKS: readonly Lock[] = ['locked', 'expired'];

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

function cardProps(
  pos: CardProps['pos'],
  confirms: ConfirmState,
  setConfirm: CardProps['setConfirm'],
): CardProps {
  const input: StakeInputState = {
    amount: '', setAmount: noop,
    lock: LOCK_OPTIONS[0]!, setLock: noop,
    extendLockDuration: LOCK_OPTIONS[0]!, setExtendLockDuration: noop,
  };
  return {
    isConnected: true,
    pos,
    actions: actions as unknown as CardProps['actions'],
    nft: { holdsJBAC: false } as unknown as CardProps['nft'],
    input,
    confirms,
    setConfirm,
    pool: { apr: '100', aprNum: 100, isDeployed: true },
    computed: {
      boostDisplay: '2.00', totalBoostBps: 20_000, amtNum: 0,
      effectiveStake: 0, stakeNeedsApproval: false,
    },
    handleStake: noop,
    lastActionRef: { current: null },
    submittedAmountRef: { current: null },
  };
}

/** FarmPage in miniature: the real position hook, and the confirm state it owns. */
function Harness() {
  const pos = useUserPosition();
  const [confirms, setConfirms] = useState<ConfirmState>(CLOSED);
  const setConfirm = (k: keyof ConfirmState, v: boolean) => setConfirms((p) => ({ ...p, [k]: v }));
  return <StakingCard {...cardProps(pos, confirms, setConfirm)} />;
}

/** A staker whose every read lands, except `paused` when asked for 'unread'. */
function stubStaker({ lock, paused }: { lock: Lock; paused: boolean | 'unread' }) {
  const now = Math.floor(Date.now() / 1000);
  const lockEnd = lock === 'locked' ? now + 40 * 86_400 : now - 86_400;
  wagmiMock.setReadResult({ functionName: 'userTokenId', result: TOKEN_ID });
  wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n });
  wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
  // Non-zero so "Claim Unsettled" renders and its pause gate is observable.
  wagmiMock.setReadResult({ functionName: 'unsettledRewards', result: 5n * 10n ** 18n });
  // A landed 0n rate: keeps the live counter still, so no interval runs here.
  wagmiMock.setReadResult({ functionName: 'rewardRate', result: 0n });
  wagmiMock.setReadResult({ functionName: 'totalBoostedStake', result: 10n ** 24n });
  wagmiMock.setReadResult({
    functionName: 'getPosition',
    // [amount, boostBps, lockEnd, lockDuration, autoMaxLock, canWithdraw].
    // canWithdraw is the contract's own `block.timestamp >= lockEnd`.
    result: [STAKED_WEI, 20_000n, BigInt(lockEnd), BigInt(90 * 86_400), false, lock === 'expired'],
  });
  wagmiMock.setReadResult({ functionName: 'earned', result: EARNED_WEI });
  if (paused === 'unread') {
    wagmiMock.setReadResult({ functionName: 'paused', result: undefined, status: 'failure' });
  } else {
    wagmiMock.setReadResult({ functionName: 'paused', result: paused });
  }
}

/** Any version of the pause exit, old label included. */
const exitDoor = () =>
  screen.queryByRole('button', { name: /emergency withdraw|withdraw \+ claim|emergency exit/i });

/** Every whenNotPaused control the card shows this staker. */
function pauseGatedControls(lock: Lock): HTMLElement[] {
  const names: RegExp[] = [/^claim rewards$/i, /^claim unsettled$/i, /^enable auto-max lock$/i];
  if (lock === 'locked') {
    names.push(/^revalidate boost$/i, /^extend lock$/i, new RegExp(PENALTY_COPY.earlyExitLabel, 'i'));
  } else {
    names.push(/^withdraw$/i);
  }
  return names.map((name) => screen.getByRole('button', { name }));
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  vi.clearAllMocks();
});

describe('StakingCard × useUserPosition — pause state: UNREAD', () => {
  it('says the pause state is unknown instead of rendering "not paused"', () => {
    // OLD: the hook collapsed the failed read to `false`, and the card rendered
    // an ordinary running position with nothing to say a read had failed.
    // NEW: an explicit notice that must not read as "running normally".
    stubStaker({ lock: 'expired', paused: 'unread' });
    renderWithProviders(<Harness />);

    const notice = screen.getByTestId('staking-paused-unread');
    expect(notice).toHaveTextContent(/could not read whether staking is paused/i);
    expect(notice).toHaveTextContent(/not a statement that staking is running normally/i);
    expect(within(notice).getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // An unknown pause is not a reported one.
    expect(screen.queryByTestId('staking-paused')).toBeNull();
  });

  it.each(LOCKS)('arms no exit door on a pause nobody read (%s lock)', (lock) => {
    // NOT DISCRIMINATING against the old code, which showed no door on its
    // `false` either. Kept as the guard rail for the chosen UX: fails if a later
    // change arms a door on an unread pause - emergencyWithdrawPosition reverts
    // ExpectedPause on a running contract, and the user pays the gas.
    stubStaker({ lock, paused: 'unread' });
    renderWithProviders(<Harness />);
    expect(exitDoor()).toBeNull();
  });

  it.each(LOCKS)('switches no control off on an unread pause (%s lock)', (lock) => {
    // NOT DISCRIMINATING against the old code. The other guard rail: an unknown
    // pause must not lock a staker out of a card that may be working normally.
    stubStaker({ lock, paused: 'unread' });
    renderWithProviders(<Harness />);
    for (const control of pauseGatedControls(lock)) expect(control).toBeEnabled();
  });

  it('Retry on the notice refetches the reads', () => {
    // OLD: there was no notice, so there was nothing to retry from.
    const refetchAll = vi.fn();
    const pos = {
      hasPosition: true, positionUnread: false, isLoading: false,
      isLocked: false, autoMaxLock: false, canWithdraw: true, isPaused: null,
      lockEnd: Math.floor(Date.now() / 1000) - 86_400, tokenId: TOKEN_ID,
      accrualPerSec: 0, boostMultiplier: 1, pendingFormatted: '42.5', pendingLive: 0,
      stakedFormatted: '1000', unsettledFormatted: '0', walletBalanceFormatted: '0',
      refetchAll,
    } as unknown as CardProps['pos'];
    renderWithProviders(<StakingCard {...cardProps(pos, CLOSED, noop)} />);

    fireEvent.click(within(screen.getByTestId('staking-paused-unread')).getByRole('button', { name: /retry/i }));
    expect(refetchAll).toHaveBeenCalledTimes(1);
  });
});

describe('StakingCard × useUserPosition — pause state: a GENUINE false', () => {
  it.each(LOCKS)('a running contract gets no banner, no notice, no door, and live controls (%s lock)', (lock) => {
    // Passes on the old code too - the anti-vacuity partner for everything
    // above and below: it fails if the fix is widened into treating a READ
    // `false` as a pause or as unknown.
    stubStaker({ lock, paused: false });
    renderWithProviders(<Harness />);
    expect(screen.queryByTestId('staking-paused')).toBeNull();
    expect(screen.queryByTestId('staking-paused-unread')).toBeNull();
    expect(exitDoor()).toBeNull();
    for (const control of pauseGatedControls(lock)) expect(control).toBeEnabled();
  });
});

describe('StakingCard × useUserPosition — PAUSED, lock still ACTIVE', () => {
  it('names the only door that works for a locked stake', () => {
    // OLD: "Emergency Exit (Forfeit Rewards)", wired to emergencyExitPosition,
    // which reverts LockStillActive for this exact staker.
    stubStaker({ lock: 'locked', paused: true });
    renderWithProviders(<Harness />);
    expect(screen.getByRole('button', { name: /^emergency withdraw \(forfeits rewards\)$/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /emergency exit/i })).toBeNull();
  });

  it('confirms with the real trade and sends emergencyWithdraw, never emergencyExit', () => {
    // OLD: the confirm called actions.emergencyExit -> emergencyExitPosition ->
    // a guaranteed revert while the lock is active.
    stubStaker({ lock: 'locked', paused: true });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /emergency withdraw/i }));

    // The trade, stated before the click that makes it: all of the stake back,
    // no penalty, and the rewards - with the figure - gone.
    const panel = screen.getByTestId('staking-pause-exit-confirm');
    expect(panel).toHaveTextContent(/returns your full 1000 TOWELI with no early-exit penalty/i);
    expect(panel).toHaveTextContent(/forfeits your unclaimed rewards/i);
    expect(panel).toHaveTextContent(/42\.5/);

    fireEvent.click(screen.getByRole('button', { name: /confirm emergency withdraw/i }));
    expect(actions.emergencyWithdraw).toHaveBeenCalledWith(TOKEN_ID);
    expect(actions.emergencyExit).not.toHaveBeenCalled();
  });

  it('does not quote a forfeit figure nobody read', () => {
    // earned() failed, so pendingFormatted collapsed to '0'. OLD: the confirm
    // never quoted a figure. NEW: it quotes one only when the read landed,
    // and says so when it did not - never "0 TOWELI" as the thing given up.
    stubStaker({ lock: 'locked', paused: true });
    wagmiMock.setReadResult({ functionName: 'earned', result: undefined, status: 'failure' });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /emergency withdraw/i }));

    const panel = screen.getByTestId('staking-pause-exit-confirm');
    expect(panel).toHaveTextContent(/amount could not be read/i);
    expect(panel).not.toHaveTextContent(/currently 0 TOWELI/i);
  });

  it('switches off every whenNotPaused control and says why', () => {
    // OLD: no banner, and all six stayed live - each one a guaranteed
    // EnforcedPause revert that still spends gas.
    stubStaker({ lock: 'locked', paused: true });
    renderWithProviders(<Harness />);
    expect(screen.getByTestId('staking-paused')).toHaveTextContent(/staking is paused/i);
    for (const control of pauseGatedControls('locked')) expect(control).toBeDisabled();
    // The pause must not switch off the one door that works during it.
    expect(exitDoor()).toBeEnabled();
  });
});

describe('StakingCard × useUserPosition — PAUSED, lock EXPIRED', () => {
  it('offers the pause-independent door and never says it forfeits anything', () => {
    // OLD: "Emergency Exit (Forfeit Rewards)" + "forfeits all pending rewards",
    // but emergencyExitPosition PAYS them (fork: 1,099.03 back on 1,000 staked).
    stubStaker({ lock: 'expired', paused: true });
    renderWithProviders(<Harness />);
    expect(screen.queryByText(/forfeit/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^withdraw \+ claim \(works while paused\)$/i }));
    const panel = screen.getByTestId('staking-pause-exit-confirm');
    expect(panel).toHaveTextContent(/pays the rewards it has earned/i);
    expect(panel).not.toHaveTextContent(/forfeit/i);
  });

  it('confirm sends emergencyExit (emergencyExitPosition), not the forfeiting door', () => {
    // The ROUTING assertion is also true of the old code, which sent
    // emergencyExitPosition to everyone - the old code fails this test only at
    // the relabelled button. Kept as the other half of the split: it fails if the
    // split ever collapses onto the forfeiting door, which would cost this
    // staker the rewards it has earned.
    stubStaker({ lock: 'expired', paused: true });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /withdraw \+ claim/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm withdraw \+ claim/i }));
    expect(actions.emergencyExit).toHaveBeenCalledWith(TOKEN_ID);
    expect(actions.emergencyWithdraw).not.toHaveBeenCalled();
  });

  it('switches off Withdraw, Claim and the rest while paused', () => {
    // OLD: "Withdraw" stayed live for an expired lock during a pause - an
    // EnforcedPause revert - while the exit that works sat below it mislabelled.
    stubStaker({ lock: 'expired', paused: true });
    renderWithProviders(<Harness />);
    for (const control of pauseGatedControls('expired')) expect(control).toBeDisabled();
    expect(exitDoor()).toBeEnabled();
  });
});
