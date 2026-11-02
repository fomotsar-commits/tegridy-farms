/**
 * STAKING RELEASE 1 — the old contract's door, and the fee each contract quotes.
 *
 * The release moved new stakes to a TegridyStaking whose early exit costs 75%. The first
 * relaunch contract (OLD_TEGRIDY_STAKING_ADDRESS) stays live: its positions keep their own
 * terms, 25% early exit included, because a deployed constant cannot change. Before this,
 * the site read ONE staking address and quoted ONE global "25%", so after the switch a
 * holder on the old contract would have seen no position at all, and a new staker would
 * have been quoted the old contract's fee.
 *
 * These render the REAL hooks over wagmi-mocks, with every read stubbed BY ADDRESS, so a
 * read or a write aimed at the wrong contract finds no stub (or the wrong one) and fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { screen, fireEvent, within } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));

import { toast } from 'sonner';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { OldStakingCard, OldStakingNotice } from './OldStakingCard';
import { StakingCard, type ConfirmState } from './StakingCard';
import { useUserPosition } from '../../hooks/useUserPosition';
import { useFarmActions } from '../../hooks/useFarmActions';
import { BETA_OVER_LINE } from '../../lib/stakingBetaOver';
import {
  CHAIN_ID,
  LOCK_OPTIONS,
  TOWELI_ADDRESS,
  OLD_TEGRIDY_STAKING_ADDRESS,
  OLD_STAKING_MONITOR_VIEW_ADDRESS,
  OLD_REVENUE_DISTRIBUTOR_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  STAKING_MONITOR_VIEW_ADDRESS,
  EARLY_WITHDRAWAL_PENALTY_BPS,
  OLD_EARLY_WITHDRAWAL_PENALTY_BPS,
} from '../../lib/constants';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const TOKEN_ID = 7n;
const STAKED_WEI = 1000n * 10n ** 18n;

/** Every read a position needs, answered ONLY at `staking` / `monitor`. */
function stubPosition(staking: string, monitor: string, opts: { autoMaxLock?: boolean; tokenId?: bigint } = {}) {
  const lockEnd = Math.floor(Date.now() / 1000) + 400 * 86_400;
  const at = (address: string, functionName: string, result: unknown) =>
    wagmiMock.setReadResult({ address, functionName, result });
  at(staking, 'userTokenId', opts.tokenId ?? TOKEN_ID);
  at(staking, 'paused', false);
  at(staking, 'unsettledRewards', 0n);
  at(staking, 'rewardRate', 0n);
  at(staking, 'totalBoostedStake', 10n ** 24n);
  at(monitor, 'getPosition', [STAKED_WEI, 20_000n, BigInt(lockEnd), BigInt(1460 * 86_400), opts.autoMaxLock ?? false, false]);
  at(monitor, 'earned', 5n * 10n ** 18n);
  at(TOWELI_ADDRESS, 'balanceOf', 0n);
  at(TOWELI_ADDRESS, 'allowance', 0n);
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  vi.mocked(toast.error).mockClear();
});

describe('<OldStakingCard /> — a position on the first relaunch contract', () => {
  it('renders nothing for a wallet with nothing on the old contract', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS, { tokenId: 0n });
    renderWithProviders(<OldStakingCard />);
    expect(screen.queryByTestId('old-staking-card')).toBeNull();
  });

  it('reads the position from the OLD contract and its own monitor, and quotes ITS 25%', () => {
    // Only the old contract answers: a card still reading the current address finds nothing.
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS);
    renderWithProviders(<OldStakingCard />);
    const card = screen.getByTestId('old-staking-card');
    expect(within(card).getByText('Your position on the old contract')).toBeInTheDocument();
    const pct = `${OLD_EARLY_WITHDRAWAL_PENALTY_BPS / 100}%`;
    expect(within(card).getByTestId('old-staking-money-line').textContent).toContain(`costs ${pct} of your stake`);
    const exit = within(card).getByRole('button', { name: /DEA Raid Tax/i });
    expect(exit.textContent).toContain(`(${pct})`);
    expect(card.textContent).not.toContain(`${EARLY_WITHDRAWAL_PENALTY_BPS / 100}%`);
  });

  it('offers no stake, and nothing that commits the old position for longer', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS);
    renderWithProviders(<OldStakingCard />);
    const card = screen.getByTestId('old-staking-card');
    for (const name of [/extend lock/i, /enable auto-max lock/i, /revalidate boost/i, /stake & lock/i, /approve toweli/i]) {
      expect(within(card).queryByRole('button', { name }), String(name)).toBeNull();
    }
    expect(within(card).queryByRole('textbox')).toBeNull();
    // Claim stays.
    expect(within(card).getByRole('button', { name: /claim rewards/i })).toBeInTheDocument();
  });

  it('keeps the OFF switch for Auto-Max, so a 4-year auto-lock can still run out', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS, { autoMaxLock: true });
    renderWithProviders(<OldStakingCard />);
    fireEvent.click(screen.getByRole('button', { name: /disable auto-lock/i }));
    expect(wagmiMock.writeContract()).toHaveBeenCalledWith(expect.objectContaining({
      address: OLD_TEGRIDY_STAKING_ADDRESS, functionName: 'toggleAutoMaxLock', args: [TOKEN_ID],
    }));
  });

  it('leaving early quotes 25% of the stake and sends earlyWithdraw to the OLD contract', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS);
    wagmiMock.setReadResult({ address: OLD_REVENUE_DISTRIBUTOR_ADDRESS, functionName: 'pendingETH', result: 0n });
    renderWithProviders(<OldStakingCard />);
    fireEvent.click(screen.getByRole('button', { name: /DEA Raid Tax/i }));
    expect(screen.getByText(/250\.00 TOWELI/)).toBeInTheDocument();
    expect(screen.getByText(/750\.00 TOWELI/)).toBeInTheDocument();
    expect(screen.getByTestId('early-exit-pot-warning').textContent).toMatch(/only what the reward pot holds[\s\S]*still pay the 25%/);
    fireEvent.click(screen.getByRole('button', { name: /pay the dea raid tax/i }));
    expect(wagmiMock.writeContract()).toHaveBeenCalledWith(expect.objectContaining({
      address: OLD_TEGRIDY_STAKING_ADDRESS, functionName: 'earlyWithdraw', args: [TOKEN_ID],
    }));
  });

  it('the unclaimed-ETH guard and the ETH claim use the OLD distributor', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS);
    // The current distributor owes nothing; the old one owes 0.1 ETH. Reading the wrong one
    // would wave the exit through and forfeit the 0.1.
    wagmiMock.setReadResult({ address: REVENUE_DISTRIBUTOR_ADDRESS, functionName: 'pendingETH', result: 0n });
    wagmiMock.setReadResult({ address: OLD_REVENUE_DISTRIBUTOR_ADDRESS, functionName: 'pendingETH', result: 10n ** 17n });
    renderWithProviders(<OldStakingCard />);
    fireEvent.click(screen.getByRole('button', { name: /DEA Raid Tax/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay the dea raid tax/i }));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toMatch(/0\.100000 ETH unclaimed/);
    const claim = screen.getByTestId('old-staking-eth-claim');
    fireEvent.click(within(claim).getByRole('button', { name: /claim eth/i }));
    expect(wagmiMock.writeContract()).toHaveBeenCalledWith(expect.objectContaining({
      address: OLD_REVENUE_DISTRIBUTOR_ADDRESS, functionName: 'claim',
    }));
  });

  it('says so when the old contract could not be read, instead of rendering nothing', () => {
    // No stubs at all: every read fails.
    renderWithProviders(<OldStakingCard />);
    expect(within(screen.getByTestId('old-staking-card')).getByTestId('staking-position-unread')).toBeInTheDocument();
  });
});

describe('useFarmActions on a contract that takes no new stakes', () => {
  function Probe({ run }: { run: (a: ReturnType<typeof useFarmActions>) => void }) {
    const actions = useFarmActions({ staking: OLD_TEGRIDY_STAKING_ADDRESS, monitor: OLD_STAKING_MONITOR_VIEW_ADDRESS, revenueDistributor: OLD_REVENUE_DISTRIBUTOR_ADDRESS, penaltyBps: OLD_EARLY_WITHDRAWAL_PENALTY_BPS, acceptsStakes: false, hasRewardSchedule: false });
    return <button type="button" onClick={() => run(actions)}>go</button>;
  }

  it('refuses stake and approve before any signature', () => {
    renderWithProviders(<Probe run={(a) => { a.approve('100'); a.stake('100', 7n * 86_400n); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(2);
  });
});

describe('the card for NEW stakes quotes the new contract\'s 75%, and the dry-pot trap', () => {
  const CLOSED: ConfirmState = { withdraw: false, earlyWithdraw: false, emergencyExit: false, extendLock: false, autoMaxLock: false };
  type Props = ComponentProps<typeof StakingCard>;
  const noop = () => {};

  function Current({ pool }: { pool?: Props['pool'] }) {
    const pos = useUserPosition();
    const actions = useFarmActions();
    const [confirms, setConfirms] = useState<ConfirmState>(CLOSED);
    return (
      <StakingCard
        isConnected pos={pos} actions={actions}
        nft={{ holdsJBAC: false } as unknown as Props['nft']}
        input={{ amount: '', setAmount: noop, lock: LOCK_OPTIONS[0]!, setLock: noop, extendLockDuration: LOCK_OPTIONS[0]!, setExtendLockDuration: noop }}
        confirms={confirms}
        setConfirm={(k, v) => setConfirms((p) => ({ ...p, [k]: v }))}
        pool={pool}
        computed={{ boostDisplay: '1.00', totalBoostBps: 10_000, amtNum: 0, effectiveStake: 0, stakeNeedsApproval: false }}
        handleStake={noop}
        lastActionRef={{ current: null }}
        submittedAmountRef={{ current: null }}
      />
    );
  }

  it('the stake form says how the pot pays out (over four years) and the 75%, before any money goes in', () => {
    stubPosition(TEGRIDY_STAKING_ADDRESS, STAKING_MONITOR_VIEW_ADDRESS, { tokenId: 0n });
    wagmiMock.setReadResult({ address: TEGRIDY_STAKING_ADDRESS, functionName: 'maxStakePerUser', result: 50_000n * 10n ** 18n });
    renderWithProviders(<Current />);
    const line = screen.getByTestId('stake-exit-risk-line').textContent ?? '';
    expect(line).toContain(`pay ${EARLY_WITHDRAWAL_PENALTY_BPS / 100}% of your stake`);
    expect(line).toMatch(/share of the reward pot, paid out over four years/);
    // The new contract only schedules what it was given, so a "short pot" warning would be false.
    expect(line).not.toMatch(/cannot cover|short/);
    expect(EARLY_WITHDRAWAL_PENALTY_BPS).toBe(7500);
  });

  it('leaving early quotes 75%, rewards first, and no short-pot scare on a contract that only schedules what it was given', () => {
    stubPosition(TEGRIDY_STAKING_ADDRESS, STAKING_MONITOR_VIEW_ADDRESS);
    renderWithProviders(<Current pool={{ apr: '0', aprNum: 0, isDeployed: true, isDry: true }} />);
    fireEvent.click(screen.getByRole('button', { name: /DEA Raid Tax \(75%\)/i }));
    expect(screen.getByText(/750\.00 TOWELI/)).toBeInTheDocument(); // the penalty
    expect(screen.getByText(/250\.00 TOWELI/)).toBeInTheDocument(); // what comes back
    const warning = screen.getByTestId('early-exit-pot-warning').textContent ?? '';
    expect(warning).toMatch(/rewards so far are paid first[\s\S]*pay the 75%/);
    expect(warning).not.toMatch(/empty|short|lose/);
  });
});

describe('<OldStakingNotice /> — the Dashboard must not call an old stake "no position"', () => {
  it('points an old-contract holder at the Farm page, with that contract\'s fee', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS);
    renderWithProviders(<OldStakingNotice />);
    const note = screen.getByTestId('old-staking-notice');
    expect(note.textContent).toMatch(/1,000 TOWELI staked on the old contract/);
    expect(note.textContent).toContain('costs 25%');
    expect(within(note).getByRole('link', { name: /farm page/i })).toBeInTheDocument();
  });

  it('is silent for a wallet with nothing there', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS, { tokenId: 0n });
    renderWithProviders(<OldStakingNotice />);
    expect(screen.queryByTestId('old-staking-notice')).toBeNull();
  });
});

describe('<OldStakingCard /> — TOWELI staking v1 is closing (lib/stakingBetaOver)', () => {
  /** v1's pool, answered ONLY at the old contract: 1,000 staked, 2,000 held, so 1,000 left for rewards. */
  function stubOldPool() {
    const at = (address: string, functionName: string, result: unknown) =>
      wagmiMock.setReadResult({ address, functionName, result });
    at(OLD_TEGRIDY_STAKING_ADDRESS, 'totalStaked', STAKED_WEI);
    at(OLD_TEGRIDY_STAKING_ADDRESS, 'totalUnsettledRewards', 0n);
    at(TOWELI_ADDRESS, 'balanceOf', 2n * STAKED_WEI);
  }

  it("says where v1 stands from the OLD contract's own pool reads", () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS);
    stubOldPool();
    renderWithProviders(<OldStakingCard />);
    // Rate 0 and 1,000 left against 5 owed: a card reading the new contract's pool would say "could not read".
    expect(screen.getByTestId('staking-beta-over')).toHaveTextContent(BETA_OVER_LINE['claim-now']);
  });

  it('an IOU left after the position closed is claimed here, from the OLD contract, and not during a pause', () => {
    stubPosition(OLD_TEGRIDY_STAKING_ADDRESS, OLD_STAKING_MONITOR_VIEW_ADDRESS, { tokenId: 0n });
    stubOldPool();
    wagmiMock.setReadResult({ address: OLD_TEGRIDY_STAKING_ADDRESS, functionName: 'unsettledRewards', result: 12n * 10n ** 18n });
    const { unmount } = renderWithProviders(<OldStakingCard />);
    const iou = screen.getByTestId('old-staking-iou-claim');
    expect(iou).toHaveTextContent(/12 TOWELI/);
    fireEvent.click(within(iou).getByRole('button', { name: /claim unsettled/i }));
    expect(wagmiMock.writeContract()).toHaveBeenCalledWith(expect.objectContaining({
      address: OLD_TEGRIDY_STAKING_ADDRESS, functionName: 'claimUnsettled',
    }));
    unmount();

    wagmiMock.setReadResult({ address: OLD_TEGRIDY_STAKING_ADDRESS, functionName: 'paused', result: true });
    renderWithProviders(<OldStakingCard />);
    expect(within(screen.getByTestId('old-staking-iou-claim')).getByRole('button', { name: /claim unsettled/i })).toBeDisabled();
    // Paused, the 25% is not what leaving costs (the pause exit is free), so it is not quoted up top.
    expect(screen.queryByTestId('old-staking-money-line')).toBeNull();
  });
});
