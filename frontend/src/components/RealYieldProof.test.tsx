// RealYieldProof: where the swap fee goes (the treasury Safe, owner ruling 2026-11-15), and what
// the stakers' payout contract has paid. A zero is only publishable when a read returned it: an
// RPC outage once printed a "not yet paid" claim about the chain on a call that never came back.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';
import { render, screen } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ ethUsd: 3000 }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, {
    get: () => ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  });
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

import { RealYieldProof } from './RealYieldProof';
import { REVENUE_DISTRIBUTOR_ADDRESS, TREASURY_ADDRESS, isDeployed } from '../lib/constants';

/** ~1.5 ETH distributed, ~0.75 claimed, 3 epochs. */
function seedHealthyReads() {
  wagmiMock.setReadResult({ functionName: 'totalDistributed', result: 1_500_000_000_000_000_000n });
  wagmiMock.setReadResult({ functionName: 'totalClaimed', result: 750_000_000_000_000_000n });
  wagmiMock.setReadResult({ functionName: 'epochCount', result: 3n });
}

describe('RealYieldProof', () => {
  beforeEach(() => wagmiMock.reset());

  it('is exercised against a wired distributor address', () => {
    expect(isDeployed(REVENUE_DISTRIBUTOR_ADDRESS)).toBe(true);
  });

  it('renders the proven figures once a distribution has landed', () => {
    seedHealthyReads();
    render(<RealYieldProof />);
    expect(screen.getByText(/Where swap fees go/i)).toBeTruthy();
    expect(screen.getByText('1.5000 ETH')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('50.0%')).toBeTruthy();
  });

  it('renders nothing at all when the reads fail and it was not asked to show empty', () => {
    // No stubs => every read reports failure.
    const { container } = render(<RealYieldProof />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on a genuine on-chain zero in the default (self-gated) mode', () => {
    wagmiMock.setReadResult({ functionName: 'totalDistributed', result: 0n });
    wagmiMock.setReadResult({ functionName: 'totalClaimed', result: 0n });
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 0n });
    const { container } = render(<RealYieldProof />);
    expect(container.innerHTML).toBe('');
  });

  // ── the core distinction ─────────────────────────────────────────────────
  it('says nothing was paid only when the chain actually said zero', () => {
    wagmiMock.setReadResult({ functionName: 'totalDistributed', result: 0n });
    render(<RealYieldProof showWhenEmpty />);
    expect(screen.getByText(/No ETH has been paid to stakers/i)).toBeTruthy();
  });

  it('an unreturned read renders unread, never "nothing was paid"', () => {
    wagmiMock.setReadResult({ functionName: 'totalDistributed', result: undefined, status: 'failure' });
    render(<RealYieldProof showWhenEmpty />);
    expect(screen.queryByText(/No ETH has been paid/i)).toBeNull();
    expect(screen.getByText(/Not read yet/i)).toBeTruthy();
  });

  // Owner ruling 2026-11-15: every venue fee goes to the treasury Safe. Whatever the payout
  // read says, the panel names that destination, links the Safe, and promises stakers nothing.
  it.each([
    ['paid', () => seedHealthyReads()],
    ['empty', () => wagmiMock.setReadResult({ functionName: 'totalDistributed', result: 0n })],
    ['unread', () => wagmiMock.setReadResult({ functionName: 'totalDistributed', result: undefined, status: 'failure' })],
  ])('in the %s state it sends the swap fee to the treasury and links the treasury Safe', (_state, seed) => {
    seed();
    const { container } = render(<RealYieldProof showWhenEmpty />);
    expect(container.textContent).toMatch(/To the venue.s treasury, not to stakers/);
    expect(container.querySelector(`a[href*="${TREASURY_ADDRESS}"]`)).not.toBeNull();
    expect(container.textContent).not.toMatch(/distributed to stakers|real yield|not yet paid/i);
    expect(container.textContent).not.toContain('—');
  });

  // HONESTY GUARD: the degraded surface has to disclose its own limit, and must
  // not let a reader take the absence of a number for the number zero.
  it('the unavailable state states that it is a gap, not a zero', () => {
    wagmiMock.setReadResult({ functionName: 'totalDistributed', result: undefined, status: 'failure' });
    const { container } = render(<RealYieldProof showWhenEmpty />);
    expect(container.textContent).toMatch(/not a figure of zero/i);
    expect(container.textContent).toMatch(/has not returned/i);
    // It still hands the reader the primary source it could not read for them.
    expect(container.querySelector(`a[href*="${REVENUE_DISTRIBUTOR_ADDRESS}"]`)).not.toBeNull();
  });

  describe('partial outages', () => {
    it('dashes the epoch count rather than printing zero epochs over a live distribution', () => {
      seedHealthyReads();
      wagmiMock.setReadResult({ functionName: 'epochCount', result: undefined, status: 'failure' });
      const { container } = render(<RealYieldProof />);
      expect(screen.queryByText('0')).toBeNull();
      expect(container.textContent).toMatch(/read unavailable/i);
    });

    it('dashes the claimed percentage rather than printing 0.0% claimed', () => {
      seedHealthyReads();
      wagmiMock.setReadResult({ functionName: 'totalClaimed', result: undefined, status: 'failure' });
      const { container } = render(<RealYieldProof />);
      expect(screen.queryByText('0.0%')).toBeNull();
      expect(container.textContent).toMatch(/read unavailable/i);
    });
  });
});
