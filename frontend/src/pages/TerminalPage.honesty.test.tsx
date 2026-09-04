// What the terminal page SAYS, in every state this build can reach.
//
// The unit tests next to lib/terminal pin the rules. This pins the screen, which
// is the only thing a trader actually reads. Three claims are asserted by
// ABSENCE, and absence is exactly how they would regress:
//
//   1. A refusal never draws a table. Not an empty one — none. An empty
//      new-pool table asserts that nothing is launching, which is a claim about
//      an entire chain produced by a rate limit.
//   2. Nowhere on this page, in any state, does a green safety mark appear over
//      a row that was not fully read — and on this build no feed row can be.
//   3. The Venue-pairs tab does not exist without an indexer, and the sentence
//      that replaces it names the variable.
//
// The market feed is exercised through the REAL hook and the REAL parser with
// `fetch` stubbed, rather than by mocking useMarketFeed. Mocking the hook would
// let the page pass while the thing that decides "refusal or empty market" went
// untested — which is the whole surface.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SAFETY_NOT_REQUESTED,
  assessRowSafety,
  componentRead,
  componentUnread,
  type RowSafety,
} from '../lib/terminal/rowSafety';
import type { TerminalFeed } from '../lib/terminal/feed';
import type { IndexedStatus } from '../hooks/useTerminalFeed';
import { __resetMarketFeedCacheForTests } from '../hooks/useMarketFeed';

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
vi.mock('../hooks/useTerminalSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useTerminalSafety')>();
  return {
    ...actual,
    useTerminalSafety: () => ({
      safety: safetyState.current ?? SAFETY_NOT_REQUESTED,
      loading: safetyState.loading,
      scanStatus: 'idle',
      deployerStatus: 'idle',
      heatStatus: 'idle' as const,
    }),
  };
});

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

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/lib/geckoTerminal/fixtures', name), 'utf8'),
  );
}
const ETH_NEW = fixture('eth_new_pools.json');
const RATE_LIMITED = fixture('rate_limited_429.json');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/terminal']}>
      <TerminalPage />
    </MemoryRouter>,
  );
}

/** The market read resolves on a microtask; let it land before asserting. */
async function settle() {
  await screen.findByRole('status');
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  localStorage.clear();
  __resetMarketFeedCacheForTests();
  feedState.current = null;
  safetyState.current = null;
  safetyState.loading = false;
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_INDEXER_URL', '');
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(ETH_NEW));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('with no indexer hosted — the default state of this build', () => {
  it('renders a live market table anyway: the market feed does not need an indexer', async () => {
    // FAILS on the pre-change page, which gated the entire grid behind an
    // indexer status and rendered one amber banner and nothing else.
    const { container } = renderPage();
    await settle();
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('table tbody tr').length).toBeGreaterThan(0);
  });

  it('names GeckoTerminal, the network, the view and a fixed ISO read time', async () => {
    renderPage();
    await settle();
    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/GeckoTerminal/);
    expect(banner.textContent).toMatch(/Ethereum/);
    expect(banner.textContent).toMatch(/new pools/);
    // An ISO instant, not a relative "12s ago" that keeps counting on a page
    // nobody is refreshing.
    expect(banner.textContent).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('hides the Venue-pairs tab and names the variable that would bring it back', async () => {
    renderPage();
    await settle();
    expect(screen.queryByRole('tab', { name: /venue pairs/i })).toBeNull();
    expect(screen.getByText(/VITE_INDEXER_URL/)).toBeTruthy();
    // And it must not imply the market feed is affected by that absence.
    expect(screen.getByText(/does not need it/i)).toBeTruthy();
  });

  it('says in the header that no row is fully read, because the deployer is never resolved', async () => {
    renderPage();
    await settle();
    expect(screen.getByText(/never resolved/i)).toBeTruthy();
    expect(screen.getByText(/can never reach a pass unless you paste a deployer/i)).toBeTruthy();
  });

  it('shows no green safety mark anywhere — no feed row can be fully read on this build', async () => {
    const { container } = renderPage();
    await settle();
    const badges = container.querySelectorAll('[data-testid="safety-badge"]');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) expect(badge.getAttribute('data-tone')).toBe('unknown');
    expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
  });

  it('offers both tab strips, with the trending one attributed to the upstream', async () => {
    renderPage();
    await settle();
    expect(screen.getByRole('tablist', { name: /network/i })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: /feed/i })).toBeTruthy();
    // The venue never appears to rank: the tab is named for whose score it is.
    expect(screen.getByRole('tab', { name: /trending on geckoterminal/i })).toBeTruthy();
    for (const name of [/ethereum/i, /base/i, /solana/i]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy();
    }
  });

  it('switching network asks the new network, not the old one', async () => {
    renderPage();
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: /solana/i }));
    await settle();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/networks/solana/new_pools'))).toBe(true);
  });
});

describe('a refusal is never drawn as an empty market', () => {
  it('a 429 says the read failed, draws NO table, and states the not-a-zero rule', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RATE_LIMITED, 429));
    const { container } = renderPage();
    await settle();

    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(/the market feed could not be read/i)).toBeTruthy();
    expect(screen.getByText(/limit on the read, not a statement about the market/i)).toBeTruthy();
    expect(
      screen.getByText(/nothing on this page is a statement about what is or is not launching/i),
    ).toBeTruthy();
  });

  it('a dropped connection is its own state, and still draws no table', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = renderPage();
    await settle();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(/the market feed could not be read/i)).toBeTruthy();
    expect(screen.getByText(/did not complete, so nothing was read/i)).toBeTruthy();
  });

  it('a body we will not render is "malformed", never zero pools', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pools: [] }));
    const { container } = renderPage();
    await settle();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(/shape this build does not recognise/i)).toBeTruthy();
  });

  it('MUTATION CHECK: an upstream that genuinely answers zero says so, in the upstream’s name', async () => {
    // The other side of the same coin, and the reason the two must not share a
    // sentence: this one IS a market observation, attributed to whoever made it.
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const { container } = renderPage();
    await settle();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(/answered with no pools/i)).toBeTruthy();
    expect(screen.getByText(/not this venue/i)).toBeTruthy();
    // And it is NOT the refusal banner.
    expect(screen.queryByText(/the market feed could not be read/i)).toBeNull();
  });

  it('offers a re-read rather than leaving the page inert', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RATE_LIMITED, 429));
    renderPage();
    await settle();
    expect(screen.getByRole('button', { name: /re-read/i })).toBeTruthy();
  });
});

describe('the watchlist view says its own emptiness in words', () => {
  it('renders a sentence, not an empty table, when nothing is starred', async () => {
    renderPage();
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: /watchlist/i }));
    await settle();

    expect(screen.getByText(/nothing is watched on Ethereum yet/i)).toBeTruthy();
    // And it asked the upstream nothing, because there was nothing to ask about.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('pools/multi'))).toBe(false);
  });

  it('a star set on the market table survives into the watchlist view', async () => {
    renderPage();
    await settle();
    const star = screen.getAllByRole('button', { name: /add .* to watchlist/i })[0];
    expect(star).toBeTruthy();
    fireEvent.click(star!);

    fireEvent.click(screen.getByRole('tab', { name: /watchlist/i }));
    await settle();
    expect(screen.queryByText(/nothing is watched on Ethereum yet/i)).toBeNull();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/pools/multi/'))).toBe(true);
  });
});

// ─── The venue's own pair feed, reachable only through the readiness gate ────

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
  // excludedShareOfTotal was added to DistributionRead by TF-026 (the share of
  // supply removed before the concentration math ran) and this fixture was not
  // updated, which broke the typecheck for the whole repo. 0 is the right value
  // for a fixture named CLEAN: nothing excluded, so the verdict carries no
  // hidden qualifier.
  distribution: componentRead({ band: 'well-distributed', confidence: 'high', firedGateIds: [], excludedShareOfTotal: 0 }),
  deployer: componentRead({ created: 3, noMarket: 0, unobserved: 0, confidence: 'medium' }),
  heat: componentUnread('no heat'),
});

describe('with a ready indexer feed', () => {
  beforeEach(async () => {
    vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
    feedState.current = { status: 'ready', feed: readyFeed(), detail: null };
  });

  async function openVenuePairs() {
    renderPage();
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: /venue pairs/i }));
    await settle();
  }

  it('the tab exists ONLY because the readiness function says so', async () => {
    // Pins that the retained surface is reachable through one gate and not two:
    // without the env stub this tab does not exist at all (asserted above).
    renderPage();
    await settle();
    expect(screen.getByRole('tab', { name: /venue pairs/i })).toBeTruthy();
    // And the "why it is missing" sentence is gone when it is not missing.
    expect(screen.queryByText(/VITE_INDEXER_URL/)).toBeNull();
  });

  it('renders a table and reports what it withheld', async () => {
    await openVenuePairs();
    expect(screen.getByText(/2 pairs withheld by the indexer's allowlist/i)).toBeTruthy();
  });

  it('refuses to show a pair age the indexer cannot provide', async () => {
    await openVenuePairs();
    expect(screen.getByText(/pair age is not shown/i)).toBeTruthy();
  });

  it('shows a truncated activity window as a gap, never as a quiet pair', async () => {
    await openVenuePairs();
    expect(screen.getByText(/the activity window filled/i)).toBeTruthy();
    expect(screen.getByText(/not read — the event page filled/i)).toBeTruthy();
  });

  it('starts every row unscored — not one green mark before anything was read', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/terminal?view=indexer']}>
        <TerminalPage />
      </MemoryRouter>,
    );
    await settle();
    const badges = container.querySelectorAll('[data-testid="safety-badge"]');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.getAttribute('data-tone')).toBe('unknown');
      expect(badge.textContent).toMatch(/not scored/i);
    }
    expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
  });

  it('the "fully read" filter empties the table rather than admitting unread rows', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/terminal?view=indexer']}>
        <TerminalPage />
      </MemoryRouter>,
    );
    await settle();
    fireEvent.change(screen.getByLabelText(/safety filter/i), { target: { value: 'known-safe' } });
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(/no row matches this filter/i)).toBeTruthy();
  });

  it('the "could not be scored" filter keeps them, so the outage is visible work', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/terminal?view=indexer']}>
        <TerminalPage />
      </MemoryRouter>,
    );
    await settle();
    fireEvent.change(screen.getByLabelText(/safety filter/i), { target: { value: 'unrated' } });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('states that unscored rows sit after scored ones under either sort', async () => {
    await openVenuePairs();
    expect(
      screen.getByText(/placed after every scored row under either sort direction/i),
    ).toBeTruthy();
  });

  it('quick buy will not arm before a row is selected', async () => {
    await openVenuePairs();
    const panel = screen.getByLabelText('Quick buy');
    expect(within(panel).getByText(/select a row to load a buy/i)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /^buy$/i })).toBeNull();
  });

  it('watchlisting a row survives into the watchlist-only filter', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/terminal?view=indexer']}>
        <TerminalPage />
      </MemoryRouter>,
    );
    await settle();
    const star = screen.getAllByRole('button', { name: /add .* to watchlist/i })[0];
    fireEvent.click(star!);
    fireEvent.click(screen.getByLabelText(/watchlist only/i));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});

describe('a scored row still cannot be green unless it was fully read', () => {
  it('shows the unread reason on the inspector, not a verdict', async () => {
    safetyState.current = assessRowSafety({
      distribution: componentUnread('The holder read did not complete.'),
      deployer: componentRead({ created: 3, noMarket: 0, unobserved: 0, confidence: 'medium' }),
      heat: componentUnread('The instrument is unreachable.'),
    });
    const { container } = renderPage();
    await settle();
    const inspector = screen.getByLabelText('Safety read');
    expect(within(inspector).getByText(/select a row to read it/i)).toBeTruthy();
    expect(container.querySelectorAll('[data-tone="good"]')).toHaveLength(0);
  });

  it('a fully-read clean row is the ONLY thing that can be green', () => {
    // Asserted against the shared predicate rather than a colour literal, so a
    // restyle cannot quietly widen what counts as a pass.
    expect(CLEAN.kind === 'scored' && CLEAN.coverage).toBe('complete');
  });

  it('selecting a row shows the inspector’s claimed-deployer label, not a verified one', async () => {
    renderPage();
    await settle();
    const read = screen.getAllByRole('button', { name: /^read$/i })[0];
    fireEvent.click(read!);
    const inspector = screen.getByLabelText('Safety read');
    expect(
      within(inspector).getByText(/deployer address \(claimed — not verified against this token\)/i),
    ).toBeTruthy();
  });
});
