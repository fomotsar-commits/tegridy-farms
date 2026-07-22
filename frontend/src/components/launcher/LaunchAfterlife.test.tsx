import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Address } from 'viem';
import { LaunchAfterlife, formatMedianReturn, formatAsOf } from './LaunchAfterlife';
import type { OutcomeRecord } from '../../lib/launcher/outcomes';

// framer-motion passthrough so <m.div> renders as a plain <div> under jsdom.
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get: () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: {
      ...passthrough,
      div: ({ children, ...props }: { children?: React.ReactNode }) => (
        <div {...props}>{children}</div>
      ),
    },
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
  };
});

const DAY = 86_400;
const NOW = 1_800_000_000;

function rec(over: Partial<OutcomeRecord> & { token: Address }): OutcomeRecord {
  return {
    tier: 'flagship',
    launchedAt: NOW - 10 * DAY,
    observedAt: NOW,
    priceEth: 1,
    launchPriceEth: 1,
    liquidityEth: 10,
    launchLiquidityEth: 10,
    holderCount: 100,
    unlocks: [],
    lastTeamActivityAt: NOW - DAY,
    marketObserved: true,
    ...over,
  };
}

describe('LaunchAfterlife — cohort ledger surface', () => {
  it('renders an honest empty state when there are no launches (no fabricated data)', () => {
    render(<LaunchAfterlife outcomes={[]} />);
    expect(
      screen.getByText('No launches have graduated through this rail yet'),
    ).toBeInTheDocument();
    // The empty state must not print any tally figure.
    expect(screen.queryByText('Launches tracked')).not.toBeInTheDocument();
  });

  it('summarizes a healthy launch as still-liquid and shows a factual median', () => {
    render(
      <LaunchAfterlife
        outcomes={[rec({ token: '0x01' as Address, priceEth: 2, launchPriceEth: 1 })]}
      />,
    );
    expect(screen.getByText('Launches tracked')).toBeInTheDocument();
    expect(screen.getByText('Still liquid')).toBeInTheDocument();
    expect(screen.getByText('+100% vs launch')).toBeInTheDocument();
  });

  it('discloses market-unavailable launches instead of counting them as adverse', () => {
    render(
      <LaunchAfterlife
        outcomes={[
          rec({
            token: '0x02' as Address,
            marketObserved: false,
            liquidityEth: 0,
            launchLiquidityEth: 10,
          }),
        ]}
      />,
    );
    // Present but not tallied as a drain.
    expect(screen.getByText(/market data unavailable at the last check/)).toBeInTheDocument();
  });
});

describe('pure helpers', () => {
  it('formatMedianReturn is factual, signed, and null-safe', () => {
    expect(formatMedianReturn(1)).toBe('+100% vs launch');
    expect(formatMedianReturn(-0.5)).toBe('-50% vs launch');
    expect(formatMedianReturn(null)).toBe('—');
  });

  it('formatAsOf returns null for a null/invalid stamp', () => {
    expect(formatAsOf(null)).toBeNull();
    expect(formatAsOf(Number.NaN)).toBeNull();
    expect(typeof formatAsOf(NOW)).toBe('string');
  });
});
