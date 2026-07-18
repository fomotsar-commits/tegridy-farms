import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Address } from 'viem';
import { LaunchExplorer, outcomeFor, formatPriceReturn } from './LaunchExplorer';
import type { LaunchSummary } from '../../lib/launcher/ordering';
import type { OutcomeRecord } from '../../lib/launcher/outcomes';

// framer-motion passthrough so <m.li> renders as a plain <li> under jsdom.
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
      li: ({ children, ...props }: { children?: React.ReactNode }) => <li {...props}>{children}</li>,
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

const NOW = 1_800_000_000;
const DAY = 86_400;

function launch(over: Partial<LaunchSummary> & { token: Address }): LaunchSummary {
  return {
    tier: 'flagship',
    launchedAt: NOW - DAY,
    uniqueBuyers24h: 0,
    liquidityEth: 0,
    feeRevenueEth24h: 0,
    holderCount: 0,
    ...over,
  };
}

describe('LaunchExplorer — discovery + outcomes surface', () => {
  it('renders a clear empty state when there are no launches', () => {
    render(<LaunchExplorer launches={[]} now={NOW} />);
    expect(screen.getByText('No launches yet')).toBeInTheDocument();
  });

  it('excludes tier "none" launches (matches orderLaunches) → still empty state', () => {
    render(<LaunchExplorer launches={[launch({ token: '0x03' as Address, tier: 'none' })]} now={NOW} />);
    expect(screen.getByText('No launches yet')).toBeInTheDocument();
  });

  it('renders launches in the deterministic ordering.ts order (flagship outranks community)', () => {
    const busyCommunity = launch({
      token: '0xaaa0000000000000000000000000000000000001' as Address,
      tier: 'listable',
      uniqueBuyers24h: 100_000,
      liquidityEth: 10_000,
      holderCount: 50_000,
    });
    const quietFlagship = launch({
      token: '0xbbb0000000000000000000000000000000000002' as Address,
      tier: 'flagship',
      uniqueBuyers24h: 1,
    });

    // Pass community first; the component must still rank flagship #1.
    render(<LaunchExplorer launches={[busyCommunity, quietFlagship]} now={NOW} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // First rendered row is the flagship, regardless of input order or activity.
    expect(within(items[0]).getByText('FLAGSHIP')).toBeInTheDocument();
    expect(within(items[0]).getByText('#1')).toBeInTheDocument();
    expect(within(items[1]).getByText('COMMUNITY')).toBeInTheDocument();
  });

  it('renders factual outcome disclosures from deriveOutcomeFlags for a matched token', () => {
    const token = '0xccc0000000000000000000000000000000000003' as Address;
    const outcome: OutcomeRecord = {
      token,
      tier: 'flagship',
      launchedAt: NOW - 40 * DAY,
      observedAt: NOW,
      priceEth: 0.5,
      launchPriceEth: 1,
      liquidityEth: 1, // 90% below launch liquidity → drain disclosure
      launchLiquidityEth: 10,
      holderCount: 100,
      unlocks: [],
      lastTeamActivityAt: NOW - 5 * DAY,
    };

    render(
      <LaunchExplorer
        launches={[launch({ token, tier: 'flagship' })]}
        outcomes={{ [token]: outcome }}
        now={NOW}
      />,
    );

    // Liquidity-drain disclosure is surfaced verbatim from deriveOutcomeFlags.
    expect(screen.getByText(/Pool liquidity is 90% below its level at graduation\./)).toBeInTheDocument();
    // Factual signed price move is shown, never editorialised.
    expect(screen.getByText('-50% vs launch')).toBeInTheDocument();
  });

  it('degrades to "no snapshot" copy when a launch has no outcome record', () => {
    render(
      <LaunchExplorer
        launches={[launch({ token: '0xddd0000000000000000000000000000000000004' as Address })]}
        now={NOW}
      />,
    );
    expect(screen.getByText('No outcome snapshot recorded yet.')).toBeInTheDocument();
  });
});

describe('pure helpers', () => {
  it('outcomeFor matches on exact, lower, and upper cased keys', () => {
    const token = '0xAbC0000000000000000000000000000000000005' as Address;
    const rec = { token } as OutcomeRecord;
    expect(outcomeFor(token, { [token]: rec })).toBe(rec);
    expect(outcomeFor(token, { [token.toLowerCase()]: rec })).toBe(rec);
    expect(outcomeFor(token, undefined)).toBeUndefined();
  });

  it('formatPriceReturn is factual and signed', () => {
    const up = { priceEth: 2, launchPriceEth: 1 } as OutcomeRecord;
    const down = { priceEth: 0.2, launchPriceEth: 1 } as OutcomeRecord;
    expect(formatPriceReturn(up)).toBe('+100% vs launch');
    expect(formatPriceReturn(down)).toBe('-80% vs launch');
  });
});
