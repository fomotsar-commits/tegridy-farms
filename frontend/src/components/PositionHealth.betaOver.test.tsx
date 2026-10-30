/**
 * TOWELI staking v1 is closing and takes no lock extension or re-stake (owner,
 * 2026-10-30), so Position Health no longer sends a staker to do either: a lock's
 * end is the way out with no penalty, and Claim is not advised during a pause.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ pos: {} as Record<string, unknown> }));

vi.mock('../hooks/useUserPosition', () => ({ useUserPosition: () => state.pos }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough };
});
vi.mock('./ui/CardArt', () => ({ CardArt: () => null }));

import { PositionHealth } from './PositionHealth';

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  state.pos = {
    isDeployed: true, hasPosition: true, isLocked: true, autoMaxLock: false,
    lockEnd: now() + 3 * 86_400, boostMultiplier: 2, stakedFormatted: '1000', pendingFormatted: '0', isPaused: false,
  };
});

const show = () => render(<MemoryRouter><PositionHealth /></MemoryRouter>);

describe('PositionHealth, beta over', () => {
  it('a lock ending soon is not told to extend', () => {
    show();
    expect(screen.getByText(/your lock ends in 3d/i)).toBeInTheDocument();
    expect(screen.getByText(/whole stake can come out with no penalty/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /extend lock/i })).toBeNull();
    expect(screen.queryByText(/extend it/i)).toBeNull();
  });

  it('an ended lock is pointed at Withdraw, never Re-lock', () => {
    state.pos = { ...state.pos, isLocked: false, lockEnd: now() - 86_400 };
    show();
    expect(screen.getByRole('link', { name: /withdraw/i })).toHaveAttribute('href', '/earn/toweli');
    expect(screen.queryByRole('link', { name: /re-lock/i })).toBeNull();
  });

  it('says claim, without re-staking, and not during a read pause', () => {
    state.pos = { ...state.pos, pendingFormatted: '42.5' };
    const { unmount } = show();
    expect(screen.getByText(/claim your TOWELI rewards on the farm page/i)).toBeInTheDocument();
    expect(screen.queryByText(/re-stake/i)).toBeNull();
    unmount();
    state.pos = { ...state.pos, isPaused: true };
    show();
    expect(screen.queryByText(/ready to claim/i)).toBeNull();
  });
});
