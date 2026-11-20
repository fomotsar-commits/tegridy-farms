// Position Health prints what is owed and what is staked cut at the digit shown, never above
// it; and on an empty reward reserve it does not say a claim is ready, since a claim pays 0.
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
  // A lock with 40 days left and nothing owed: no alert, so the card names the stake.
  state.pos = {
    isDeployed: true, hasPosition: true, isLocked: true, autoMaxLock: false,
    lockEnd: now() + 40 * 86_400, boostMultiplier: 2, stakedFormatted: '1000', pendingFormatted: '0', isPaused: false,
  };
});

const show = (reserveEmpty?: boolean) => render(<MemoryRouter><PositionHealth reserveEmpty={reserveEmpty} /></MemoryRouter>);

describe('PositionHealth: amounts are cut', () => {
  it('ready to claim: 391,199.99 reads 391.1K, not 391.2K', () => {
    state.pos = { ...state.pos, pendingFormatted: '391199.99' };
    show();
    expect(screen.getByText('391.1K TOWELI ready to claim')).toBeInTheDocument();
  });

  it('ready to claim under a thousand: 999.9 reads 999, and 0.567 reads 0.56', () => {
    state.pos = { ...state.pos, pendingFormatted: '999.9' };
    const { unmount } = show();
    expect(screen.getByText('999 TOWELI ready to claim')).toBeInTheDocument();
    unmount();
    state.pos = { ...state.pos, pendingFormatted: '0.567' };
    show();
    expect(screen.getByText('0.56 TOWELI ready to claim')).toBeInTheDocument();
  });

  it('staked: 1,999,950 reads 1.9M, not 2.0M', () => {
    state.pos = { ...state.pos, stakedFormatted: '1999950' };
    show();
    expect(screen.getByText(/^1\.9M TOWELI staked at/)).toBeInTheDocument();
  });
});

describe('PositionHealth on an empty reward reserve', () => {
  it('does not say a claim is ready', () => {
    state.pos = { ...state.pos, pendingFormatted: '42.5' };
    const { unmount } = show(true);
    expect(screen.queryByText(/ready to claim/)).toBeNull();
    unmount();
    show(false);
    expect(screen.getByText('42 TOWELI ready to claim')).toBeInTheDocument();
  });
});
