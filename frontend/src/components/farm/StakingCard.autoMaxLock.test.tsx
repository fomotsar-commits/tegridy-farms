import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * AUTO-MAX LOCK must not fire on a single click.
 *
 * `TegridyStaking.toggleAutoMaxLock` sets
 * `p.lockEnd = block.timestamp + MAX_LOCK_DURATION` the moment it is enabled
 * (contracts/src/TegridyStaking.sol:1197-1203), and the contract's own docs
 * record the part that makes it irreversible:
 *
 *   "Disabling autoMaxLock does NOT restore original lockDuration. By design
 *    (perpetual MAX), but users who toggled then want a shorter conceptual lock
 *    must withdraw and re-stake fresh."
 *
 * So the enable button committed four years of a user's stake on one tap, with
 * nothing on the button saying so, and no way back short of paying the 25%
 * early-exit penalty. A 2026-09-03 field review read this as a copy-placement
 * problem — the penalty being "explained even further down". It is not: the
 * penalty is disclosed three times on this card and matches
 * EARLY_WITHDRAWAL_PENALTY_BPS exactly. The missing thing was a CONTROL.
 *
 * DISABLING deliberately stays one click. It is harmless, and gating it would
 * only make an unwanted state harder to leave.
 */

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button type="button">Connect</button>,
}));
vi.mock('wagmi', () => ({ useReadContract: () => ({ data: undefined }) }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('react-router-dom', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('framer-motion', () => ({
  m: new Proxy({}, { get: () => ({ children, ...p }: Record<string, unknown> & { children?: React.ReactNode }) =>
    <div {...(p as object)}>{children}</div> }),
}));

import { StakingCard, type ConfirmState } from './StakingCard';

const toggleAutoMaxLock = vi.fn();

function baseProps(overrides: {
  autoMaxLock?: boolean;
  confirms?: Partial<ConfirmState>;
  setConfirm?: (k: keyof ConfirmState, v: boolean) => void;
} = {}) {
  const confirms: ConfirmState = {
    withdraw: false, earlyWithdraw: false, emergencyExit: false,
    extendLock: false, autoMaxLock: false, ...overrides.confirms,
  };
  return {
    isConnected: true,
    pos: {
      hasPosition: true, tokenId: 1n, staked: 100n, stakedFormatted: '100',
      isLocked: true, lockEnd: Math.floor(Date.now() / 1000) + 86_400,
      autoMaxLock: overrides.autoMaxLock ?? false,
      earned: 0n, earnedFormatted: '0', isPaused: false, boostBps: 10_000,
      hasJbacBoost: false, jbacDeposited: false, lockDuration: 86_400,
    },
    actions: {
      toggleAutoMaxLock, earlyWithdraw: vi.fn(), withdraw: vi.fn(),
      claim: vi.fn(), stake: vi.fn(), approve: vi.fn(), extendLock: vi.fn(),
      emergencyExit: vi.fn(), isPending: false, isConfirming: false,
    },
    nft: { boostBps: 0, balance: 0n, isDeployed: false },
    input: {
      amount: '', setAmount: vi.fn(), lock: { label: '90 days', seconds: 7_776_000 },
      setLock: vi.fn(), extendLockDuration: { label: '90 days', seconds: 7_776_000 },
      setExtendLockDuration: vi.fn(),
    },
    confirms,
    setConfirm: overrides.setConfirm ?? vi.fn(),
    pool: { apr: '100', aprNum: 100, isDeployed: true },
    computed: {
      boostDisplay: '1.0x', totalBoostBps: 10_000, amtNum: 0,
      effectiveStake: 100, stakeNeedsApproval: false,
    },
    handleStake: vi.fn(),
    lastActionRef: { current: null },
    submittedAmountRef: { current: null },
  } as unknown as React.ComponentProps<typeof StakingCard>;
}

beforeEach(() => vi.clearAllMocks());

describe('Auto-Max Lock confirm gate', () => {
  it('does NOT commit four years on the first click', () => {
    const setConfirm = vi.fn();
    render(<StakingCard {...baseProps({ setConfirm })} />);

    fireEvent.click(screen.getByRole('button', { name: /enable auto-max lock/i }));

    // The whole point: the chain call must not have happened yet.
    expect(toggleAutoMaxLock).not.toHaveBeenCalled();
    expect(setConfirm).toHaveBeenCalledWith('autoMaxLock', true);
  });

  it('states the commitment, the irreversibility and the cost before confirming', () => {
    render(<StakingCard {...baseProps({ confirms: { autoMaxLock: true } })} />);

    // The commitment, in years rather than a duration the reader must convert.
    expect(screen.getByText(/four years from now/i)).toBeInTheDocument();
    // The part the contract docs call out: turning it off does not shorten it.
    // Matched on the flattened element text because "not" is emphasised in its
    // own <span>, which splits the string across nodes.
    expect(
      screen.getByText((_content, el) =>
        /does not shorten this lock/i.test(el?.textContent?.replace(/\s+/g, " ") ?? "")
        && !el?.querySelector("p"),
      ),
    ).toBeInTheDocument();
    // The cost of changing your mind, framed as what you keep.
    expect(screen.getByText(/you keep 75%/i)).toBeInTheDocument();
  });

  it('fires only after the explicit second confirmation', () => {
    render(<StakingCard {...baseProps({ confirms: { autoMaxLock: true } })} />);
    fireEvent.click(screen.getByRole('button', { name: /lock for four years/i }));
    expect(toggleAutoMaxLock).toHaveBeenCalledTimes(1);
  });

  it('can be backed out of without touching the chain', () => {
    const setConfirm = vi.fn();
    render(<StakingCard {...baseProps({ confirms: { autoMaxLock: true }, setConfirm })} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(toggleAutoMaxLock).not.toHaveBeenCalled();
    expect(setConfirm).toHaveBeenCalledWith('autoMaxLock', false);
  });

  it('leaves DISABLING as a single click', () => {
    // Gating this direction would only make an unwanted perpetual lock harder
    // to step out of. It must stay immediate.
    render(<StakingCard {...baseProps({ autoMaxLock: true })} />);
    fireEvent.click(screen.getByRole('button', { name: /disable auto-lock/i }));
    expect(toggleAutoMaxLock).toHaveBeenCalledTimes(1);
  });
});
