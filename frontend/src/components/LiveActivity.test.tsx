// LiveActivity — the globally-mounted status pill.
//
// THE BUG THIS PINS. The pill rendered a green pulsing dot and the words
// "Protocol Active" for every visitor on every non-excluded route, wired to
// nothing. A static green health indicator is a fabricated signal: it reads the
// same during a full RPC outage, a paused staking contract, and a dead price
// feed as it does when everything works, so the one moment it matters is the one
// moment it is wrong.
//
// What this file holds:
//   1. Green + the pulsing ring appear only on a proven-healthy read.
//   2. Every unproven state renders an explicit unknown/degraded word instead.
//   3. The pill never prints a price it cannot vouch for.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode, HTMLAttributes } from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { wagmiMock } from '../test-utils/wagmi-mocks';

const priceState = {
  priceInUsd: 0.000041,
  isLoaded: true,
  displayPriceStale: false,
  priceUnavailable: false,
};
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => priceState,
}));

// The sparkline fetches its own OHLCV series; not what this file is about.
vi.mock('../hooks/usePriceHistory', () => ({
  usePriceHistory: () => ({ history: [], error: null, isLoading: false }),
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

import { LiveActivity } from './LiveActivity';

/** The pill only mounts after a 2s settle timer; advance past it. */
function renderPill() {
  const utils = render(
    <MemoryRouter initialEntries={['/']}>
      <LiveActivity />
    </MemoryRouter>,
  );
  act(() => { vi.advanceTimersByTime(2500); });
  return utils;
}

/** Every coloured dot the pill draws, whatever element it drew it with. */
function dotColors(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('span'))
    .map((el) => el.style.backgroundColor)
    .filter(Boolean);
}

const GREEN_RGB = 'rgb(34, 197, 94)';

describe('LiveActivity status pill', () => {
  beforeEach(() => {
    wagmiMock.reset();
    vi.useFakeTimers();
    priceState.priceInUsd = 0.000041;
    priceState.isLoaded = true;
    priceState.displayPriceStale = false;
    priceState.priceUnavailable = false;
  });

  it('claims "Protocol Active" only after a successful unpaused read', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    const { container } = renderPill();
    expect(screen.getByText('Protocol Active')).toBeTruthy();
    expect(dotColors(container)).toContain(GREEN_RGB);
  });

  it('renders an explicit unknown — never green — when the chain read fails', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: undefined, status: 'failure' });
    const { container } = renderPill();
    expect(screen.queryByText('Protocol Active')).toBeNull();
    expect(screen.getByText(/status unknown/i)).toBeTruthy();
    expect(dotColors(container)).not.toContain(GREEN_RGB);
  });

  it('renders an explicit unknown when no read has answered yet', () => {
    const { container } = renderPill();
    expect(screen.getByText(/status unknown/i)).toBeTruthy();
    expect(dotColors(container)).not.toContain(GREEN_RGB);
  });

  it('says paused when the staking contract is paused', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: true });
    const { container } = renderPill();
    expect(screen.getByText(/paused/i)).toBeTruthy();
    expect(dotColors(container)).not.toContain(GREEN_RGB);
  });

  it('says degraded when the venue is open but no price answers', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    priceState.priceUnavailable = true;
    const { container } = renderPill();
    expect(screen.getByText(/degraded/i)).toBeTruthy();
    expect(dotColors(container)).not.toContain(GREEN_RGB);
  });

  // The pulsing ring is the part that reads as "live" at a glance. PulseDot
  // renders it as `.pulse-dot-ring`; a still dot must not draw one.
  it('animates only in the proven-healthy state', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    const healthy = renderPill();
    // useReducedMotion is stubbed true above, so assert the container instead:
    // only the healthy branch mounts PulseDot at all.
    expect(healthy.container.querySelector('.pulse-dot-container')).not.toBeNull();
    healthy.unmount();

    wagmiMock.reset();
    wagmiMock.setReadResult({ functionName: 'paused', result: undefined, status: 'failure' });
    const broken = renderPill();
    expect(broken.container.querySelector('.pulse-dot-container')).toBeNull();
  });

  // HONESTY GUARD: the pill discloses what its status was derived from, so the
  // claim is checkable rather than decorative.
  it('discloses the basis of whatever it is claiming', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    const { container } = renderPill();
    const titled = container.querySelector('[title]');
    expect(titled?.getAttribute('title') ?? '').toMatch(/paused\(\)/);
    const labelled = container.querySelector('[aria-label]');
    expect(labelled?.getAttribute('aria-label') ?? '').toMatch(/Protocol status:/);
  });

  describe('price chip', () => {
    it('prints the price only while it is current, and names the asset', () => {
      wagmiMock.setReadResult({ functionName: 'paused', result: false });
      renderPill();
      expect(screen.getByText(/TOWELI \$/)).toBeTruthy();
    });

    it('withholds a stale cached price rather than printing it as live', () => {
      wagmiMock.setReadResult({ functionName: 'paused', result: false });
      priceState.displayPriceStale = true;
      const { container } = renderPill();
      expect(container.textContent).not.toMatch(/TOWELI \$/);
      // …and the pill says why instead of just going quiet.
      expect(screen.getByText(/stale price/i)).toBeTruthy();
    });

    it('prints nothing rather than $0 when no price loaded', () => {
      wagmiMock.setReadResult({ functionName: 'paused', result: false });
      priceState.priceInUsd = 0;
      priceState.isLoaded = false;
      const { container } = renderPill();
      expect(container.textContent).not.toMatch(/\$0\.0*\b/);
    });
  });

  it('stays hidden on the long-form routes it was excluded from', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: false });
    const { container } = render(
      <MemoryRouter initialEntries={['/terms']}>
        <LiveActivity />
      </MemoryRouter>,
    );
    act(() => { vi.advanceTimersByTime(2500); });
    expect(container.innerHTML).toBe('');
  });
});
