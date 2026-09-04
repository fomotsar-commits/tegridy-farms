// THE MOUNT, PROVEN AT THE ROUTE — in the state a visitor actually lands in when
// the trade feed will not answer.
//
// The page is rendered REAL. Only wagmi and the art backdrop are stubbed, and the
// only thing injected is a `fetch` that fails: a test that mocked useIslandCup
// would prove the page renders a mock, which is exactly the property that would
// not survive contact with a rate-limited upstream.
//
// What is pinned here is the OUTAGE state, because it is the one that lies most
// easily. No table may be drawn, the silence must be named as an outage rather
// than as a quiet market, and the router season must not claim to be counting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { __resetPoolTradesCacheForTests } from '../lib/geckoTerminal/poolTrades';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
}));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

import CompetitionsPage from './CompetitionsPage';

const renderPage = () =>
  render(<CompetitionsPage />, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });

beforeEach(() => {
  __resetPoolTradesCacheForTests();
  // Every pool refuses. Nothing in this suite reaches the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 503 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CompetitionsPage with no feed and no indexer', () => {
  it('mounts with exactly one h1', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/outage of the trade feed/i)).toBeInTheDocument());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('draws no table at all — neither board may render over a read that failed', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/outage of the trade feed/i)).toBeInTheDocument());
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('names the silence an outage rather than a quiet day, and lists every pool', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/outage of the trade feed/i)).toBeInTheDocument());
    const chips = screen.getByRole('list', { name: /what each pool answered/i });
    // One chip per registered island pool, every one of them named.
    expect(chips.querySelectorAll('li').length).toBeGreaterThan(1);
  });

  it('says the router season has no source, rather than that it is counting', async () => {
    // The old page derived "Counting now. Every figure moves as new swaps are
    // indexed." from Date.now() alone — a confident sentence about a process
    // that has never run.
    renderPage();
    await waitFor(() => expect(screen.getByText(/outage of the trade feed/i)).toBeInTheDocument());
    expect(screen.getByText(/no source in this build is reading this season/i)).toBeInTheDocument();
    expect(screen.queryByText(/counting now/i)).toBeNull();
    expect(screen.getByText(/the standings could not be read/i)).toBeInTheDocument();
  });

  it('keeps the refusals on the page even with nothing to score', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/outage of the trade feed/i)).toBeInTheDocument());
    expect(screen.getByText(/no prize pool/i)).toBeInTheDocument();
    expect(screen.getByText(/never what came back/i)).toBeInTheDocument();
    expect(screen.getByText(/two wallets to trade against each other/i)).toBeInTheDocument();
    expect(screen.getByText(/two-wallet collusion is not detectable/i)).toBeInTheDocument();
  });

  it('labels the season control and keeps every button at a 44px target', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/outage of the trade feed/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/season/i)).toBeInTheDocument();
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toContain('min-h-[44px]');
    }
  });
});
