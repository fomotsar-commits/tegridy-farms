/**
 * Position Health reads the contract that takes new stakes (staking release 1). Its
 * claims, like every TegridyStaking's, are whenNotPaused, so a READ pause is no time to
 * advise one. TOWELI staking v1's own position has its own card (OldStakingCard).
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

describe('PositionHealth, paused', () => {
  it('advises Claim, and not during a read pause', () => {
    state.pos = { ...state.pos, pendingFormatted: '42.5' };
    const { unmount } = show();
    expect(screen.getByText(/ready to claim/i)).toBeInTheDocument();
    unmount();
    state.pos = { ...state.pos, isPaused: true };
    show();
    expect(screen.queryByText(/ready to claim/i)).toBeNull();
  });

  it('still tells a lock ending soon to extend: the new contract takes extensions', () => {
    show();
    expect(screen.getByText(/your lock ends in 3d/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /extend lock/i })).toHaveAttribute('href', '/earn/toweli');
  });
});
