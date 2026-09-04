/**
 * A11Y-R02 — the Extend Lock picker answers to the same contract as the STAKE
 * picker over the same LOCK_OPTIONS, 200 lines below it in the same file.
 *
 * Before this pin the extend picker was plain <button>s: no radiogroup, no
 * aria-checked, and a ~26px box. `getAllByRole('radio')` inside the
 * extend-confirm state returned NOTHING, which is what makes this a pin rather
 * than a restatement of the markup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { StakingCard, type ConfirmState, type StakeInputState } from './StakingCard';
import { LOCK_OPTIONS } from '../../lib/constants';

const noop = () => {};

function renderExtendConfirm() {
  const pos = {
    hasPosition: true,
    isLocked: true,
    autoMaxLock: false,
    canWithdraw: false,
    isLoading: false,
    isPaused: false,
    lockEnd: Math.floor(Date.now() / 1000) + 86_400 * 40,
    tokenId: 1n,
    accrualPerSec: 0,
    boostMultiplier: 1,
    pendingFormatted: '0',
    pendingLive: 0,
    stakedFormatted: '1000',
    unsettledFormatted: '0',
    walletBalanceFormatted: '0',
  };
  const actions = {
    claim: noop, claimUnsettled: noop, earlyWithdraw: noop, emergencyExit: noop,
    extendLock: noop, withdraw: noop, revalidateBoost: noop, toggleAutoMaxLock: noop,
    isConfirming: false, isPending: false,
  };
  const input: StakeInputState = {
    amount: '', setAmount: noop,
    lock: LOCK_OPTIONS[0]!, setLock: noop,
    extendLockDuration: LOCK_OPTIONS[0]!, setExtendLockDuration: noop,
  };
  const confirms: ConfirmState = {
    withdraw: false, earlyWithdraw: false, emergencyExit: false, extendLock: true,
  };
  renderWithProviders(
    <StakingCard
      isConnected
      pos={pos as unknown as React.ComponentProps<typeof StakingCard>['pos']}
      actions={actions as unknown as React.ComponentProps<typeof StakingCard>['actions']}
      nft={{ holdsJBAC: false } as unknown as React.ComponentProps<typeof StakingCard>['nft']}
      input={input}
      confirms={confirms}
      setConfirm={noop}
      computed={{
        boostDisplay: '1.00', totalBoostBps: 10_000, amtNum: 0,
        effectiveStake: 0, stakeNeedsApproval: false,
      }}
      handleStake={noop}
      lastActionRef={{ current: null }}
      submittedAmountRef={{ current: null }}
    />,
  );
}

describe('StakingCard — Extend Lock duration picker', () => {
  beforeEach(() => wagmiMock.reset());

  it('is a radiogroup with one radio per lock option', () => {
    renderExtendConfirm();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(LOCK_OPTIONS.length);
    expect(screen.getByRole('radiogroup', { name: /extend lock duration/i })).toBeInTheDocument();
  });

  it('marks the chosen option with aria-checked, not colour alone', () => {
    renderExtendConfirm();
    const checked = screen.getAllByRole('radio', { checked: true });
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent(LOCK_OPTIONS[0]!.label);
  });

  it('gives every option and both confirm buttons a 44px minimum target', () => {
    renderExtendConfirm();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.className).toContain('min-h-[44px]');
    }
    expect(screen.getByText('Cancel').className).toContain('min-h-[44px]');
    expect(screen.getByText(/^Extend /).className).toContain('min-h-[44px]');
  });
});
