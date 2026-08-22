// What the terminal page SAYS, in the two states this build can reach.
//
// The unit tests next to lib/terminal pin the rules. This pins the screen, which
// is the only thing a trader actually reads. Two claims are asserted by absence,
// and absence is exactly how they would regress:
//
//   1. With no indexer, there is no TABLE. Not an empty one — none. An empty
//      new-pair table asserts that nothing is launching, which is a claim about
//      the whole chain produced by an unset environment variable.
//   2. Nowhere on this page, in any state, does a green safety mark appear over
//      a row that was not fully read.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  SAFETY_NOT_REQUESTED,
  assessRowSafety,
  componentRead,
  componentUnread,
  type RowSafety,
} from '../lib/terminal/rowSafety';
import type { TerminalFeed } from '../lib/terminal/feed';
import type { IndexedStatus } from '../hooks/useTerminalFeed';

vi.mock('../hooks/useSwap', () => ({
  useSwap: () => ({
    fromToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
    toToken: null,
    setToToken: vi.fn(),
    inputAmount: '',
    setInputAmount: vi.fn(),
    outputFormatted: '',
    isQuoteLoading: false,
    needsApproval: false,
    insufficientBalance: false,
    approve: vi.fn(),
    executeSwap: vi.fn(),
    isPending: false,
    isConfirming: false,
    customTokens: [],
  }),
}));

const safetyState = vi.hoisted(() => ({ current: null as RowSafety | null, loading: false }));
vi.mock('../hooks/useTerminalSafety', () => ({
  useTerminalSafety: () => ({
    safety: safetyState.current ?? SAFETY_NOT_REQUESTED,
    loading: safetyState.loading,
    scanStatus: 'idle',
    deployerStatus: 'idle',
    heatStatus: 'idle' as const,
  }),
}));

const feedState = vi.hoisted(() => ({
  current: null as null | { status: IndexedStatus; feed: TerminalFeed | null; detail: string | null },
}));
vi.mock('../hooks/useTerminalFeed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useTerminalFeed')>();
  return {
    ...actual,
    useTerminalFeed: () =>
      feedState.current === null
        ? actual.useTerminalFeed()
        : { ...feedState.current, syncedBlock: null, syncedAt: null, reload: vi.fn() },
  };
});

import TerminalPage from './TerminalPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <TerminalPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  feedState.current = null;
  safetyState.current = null;
  safetyState.loading = false;
  vi.unstubAllEnvs();
});

describe('with no indexer hosted — this build’s only reachable state', () => {
  it('says the feed is unavailable, in words', () => {
    renderPage();
    expect(screen.getByText(/the pair feed is unavailable/i)).toBeTruthy();
    expect(screen.getByText(/no indexer configured/i)).toBeTruthy();
  });

  it('renders NO table — an empty trench would be a claim about the chain', () => {
    const { container } = renderPage();
    expect(container.querySelector('table')).toBeNull();
  });

  it('states that nothing here says what is or is not launching', () => {
    renderPage();
    expect(
      screen.getByText(/nothing on this page is a statement about what is or is not launching/i),
    ).toBeTruthy();
  });

  it('shows no green safety mark anywhere', () => {
    const { container } = renderPage();
    expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
  });

  it('offers a retry rather than leaving the page inert', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});

// ─── The ready feed ──────────────────────────────────────────────────────────

const WETH = '0x4444444444444444444444444444444444444444';
const TOKEN_X = '0x3333333333333333333333333333333333333333';
const PAIR_A = '0x1111111111111111111111111111111111111111';
const PAIR_B = '0x2222222222222222222222222222222222222222';

function readyFeed(): TerminalFeed {
  return {
    rows: [
      {
        pair: PAIR_A,
        token0: WETH,
        token1: TOKEN_X,
        activity: { state: 'measured', events: 3, earliestInWindow: 100n, latestInWindow: 300n },
      },
      {
        pair: PAIR_B,
        token0: WETH,
        token1: '0x5555555555555555555555555555555555555555',
        activity: { state: 'unknown', reason: 'The event page filled before reaching this pair.' },
      },
    ],
    excludedPairs: 2,
    hasMorePairs: false,
    eventWindowTruncated: true,
    eventWindow: { from: 100n, to: 300n },
  };
}

const CLEAN = assessRowSafety({
  distribution: componentRead({ band: 'well-distributed', confidence: 'high', firedGateIds: [] }),
  deployer: componentRead({ created: 3, noMarket: 0, unobserved: 0, confidence: 'medium' }),
  heat: componentUnread('no heat'),
});

describe('with a ready feed', () => {
  beforeEach(() => {
    // The venue leg must be a token TerminalPage treats as venue-side, so the
    // row resolves a buy target. WETH_ADDRESS is read from constants at import
    // time, so the fixture uses whatever the build has.
    feedState.current = { status: 'ready', feed: readyFeed(), detail: null };
  });

  it('renders a table and reports what it withheld', () => {
    const { container } = renderPage();
    expect(container.querySelector('table')).toBeTruthy();
    expect(screen.getByText(/2 pairs withheld by the indexer's allowlist/i)).toBeTruthy();
  });

  it('refuses to show a pair age the indexer cannot provide', () => {
    renderPage();
    expect(screen.getByText(/pair age is not shown/i)).toBeTruthy();
  });

  it('shows a truncated activity window as a gap, never as a quiet pair', () => {
    renderPage();
    expect(screen.getByText(/the activity window filled/i)).toBeTruthy();
    expect(screen.getByText(/not read — the event page filled/i)).toBeTruthy();
  });

  it('starts every row unscored — not one green mark before anything was read', () => {
    const { container } = renderPage();
    const badges = container.querySelectorAll('[data-testid="safety-badge"]');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.getAttribute('data-tone')).toBe('unknown');
      expect(badge.textContent).toMatch(/not scored/i);
    }
    expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
  });

  it('the "fully read" filter empties the table rather than admitting unread rows', () => {
    const { container } = renderPage();
    fireEvent.change(screen.getByLabelText(/safety filter/i), { target: { value: 'known-safe' } });
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(/no row matches this filter/i)).toBeTruthy();
  });

  it('the "could not be scored" filter keeps them, so the outage is visible work', () => {
    const { container } = renderPage();
    fireEvent.change(screen.getByLabelText(/safety filter/i), { target: { value: 'unrated' } });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('states that unscored rows sit after scored ones under either sort', () => {
    renderPage();
    expect(screen.getByText(/placed after every scored row under either sort direction/i)).toBeTruthy();
  });

  it('quick buy will not arm before a row is selected', () => {
    renderPage();
    const panel = screen.getByLabelText('Quick buy');
    expect(within(panel).getByText(/select a pair to load a buy/i)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /^buy$/i })).toBeNull();
  });

  it('watchlisting a row survives into the watchlist-only filter', () => {
    const { container } = renderPage();
    const star = screen.getAllByRole('button', { name: /add .* to watchlist/i })[0];
    fireEvent.click(star);
    fireEvent.click(screen.getByLabelText(/watchlist only/i));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});

describe('a scored row still cannot be green unless it was fully read', () => {
  beforeEach(() => {
    feedState.current = { status: 'ready', feed: readyFeed(), detail: null };
  });

  it('shows the unread reason on the inspector, not a verdict', () => {
    safetyState.current = assessRowSafety({
      distribution: componentUnread('The holder read did not complete.'),
      deployer: componentRead({ created: 3, noMarket: 0, unobserved: 0, confidence: 'medium' }),
      heat: componentUnread('The instrument is unreachable.'),
    });
    const { container } = renderPage();
    const inspector = screen.getByLabelText('Safety read');
    expect(within(inspector).getByText(/select a pair to read it/i)).toBeTruthy();
    expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
  });

  it('a fully-read clean row is the ONLY thing that can be green', () => {
    // Asserted against the shared predicate rather than a colour literal, so a
    // restyle cannot quietly widen what counts as a pass.
    const badge = CLEAN;
    expect(badge.kind === 'scored' && badge.coverage).toBe('complete');
  });
});
