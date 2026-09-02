import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { isIndexerConfigured } from '../../lib/indexer/client';
import { TOWELI_MARKET } from '../../lib/chart/market';
import { chartableMarkets } from '../../lib/chart/markets';
import { __resetGeckoCandlesCacheForTests } from '../../hooks/useGeckoCandles';
import ChartPage from './ChartPage';

// /chart used to be two "could not read" banners under a heading, because both
// halves read an indexer that is hosted nowhere. It now reads GeckoTerminal —
// the rail the bungalow pages already draw in production — over the island's own
// registry of pools.
//
// The tests below split into the two states a reader can actually be in: the
// source did not answer (the state a mock-mode e2e run and an offline visitor
// both see), and the source answered. The load-bearing property is that those
// two look NOTHING alike on screen, and that neither of them ever draws a candle
// for a bucket nobody reported.

const HOUR = 3600;
/** Epoch-aligned to the hour, so the grid check passes as it would in production. */
const T0 = 1756800000;

function envelope(list: number[][], meta?: unknown): unknown {
  return { data: { attributes: { ohlcv_list: list } }, ...(meta === undefined ? {} : { meta }) };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function renderChart(path = '/chart') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <ChartPage />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function poolButtons(): HTMLElement[] {
  return within(screen.getByRole('region', { name: 'Pool' })).getAllByRole('button');
}

beforeEach(() => {
  __resetGeckoCandlesCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ChartPage when GeckoTerminal cannot be reached', () => {
  it('is testing the state a mock-mode run is in (guards the guard)', () => {
    // No indexer in tests, so the second source stays unmounted and every
    // assertion below is about the GeckoTerminal path alone.
    expect(isIndexerConfigured()).toBe(false);
  });

  async function renderOffline() {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = renderChart();
    // Past both network retries (1 s and 2 s) so the banner has settled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    return { ...view, fetchMock };
  }

  it('asks GeckoTerminal for the venue\'s own pool on the default frame', async () => {
    const { fetchMock } = await renderOffline();
    // Pre-change this page issued NO request at all: the indexer hook parked in
    // `unavailable` before building one.
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `api.geckoterminal.com/api/v2/networks/eth/pools/${TOWELI_MARKET.pool}/ohlcv/hour`,
    );
  });

  it('still offers every registry pool, because that list is not something a source has to answer for', async () => {
    await renderOffline();
    const buttons = poolButtons();
    // Pre-change: zero buttons and a sentence saying no pool could be read.
    expect(buttons.length).toBe(chartableMarkets().length);
    expect(buttons.length).toBeGreaterThanOrEqual(12);
    // Exactly one selected — a picker with none selected leaves the chart
    // heading unattributed, and one with several is a lie about what is drawn.
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('groups the pools by the network they are actually on', async () => {
    await renderOffline();
    const region = within(screen.getByRole('region', { name: 'Pool' }));
    for (const heading of ['Ethereum', 'Base', 'Solana']) {
      expect(region.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('draws no plot at all, and says the source did not answer rather than showing a flat market', async () => {
    const { container } = await renderOffline();
    // An axis with no candles on it reads as "this did not trade". There is no
    // svg in this state, full stop.
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText(/GeckoTerminal did not answer, so no candles were read/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing here is a statement about this pool’s price or whether it traded/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps one h1 and gives every control a 44px target', async () => {
    const { container } = await renderOffline();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const controls = [
      ...poolButtons(),
      ...within(screen.getByRole('region', { name: 'Chart' })).getAllByRole('button'),
    ];
    expect(controls.length).toBeGreaterThan(12);
    for (const control of controls) {
      // Pre-change the picker used py-1.5 with no minimum height, which is a
      // ~26px target on a phone.
      expect(control.className, control.textContent ?? '').toContain('min-h-[44px]');
    }
  });

  it('states the gap rule up front and promises nothing refreshes on its own', async () => {
    await renderOffline();
    expect(
      screen.getByText(/will never draw a candle for a price that was not paid/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/there is no keeper and no stream behind it/i)).toBeInTheDocument();
  });

  it('names the indexed source as not configured instead of drawing a second failure', async () => {
    await renderOffline();
    expect(
      screen.getByText(/Indexed swaps: not configured on this deployment/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Venue pairs (indexed)' })).toBeNull();
  });

  it('says a 404 is this source\'s coverage, not the pool\'s existence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({}, 404)));
    renderChart();
    await waitFor(() =>
      expect(screen.getByText(/has not indexed it/)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/not that the pool does not exist on-chain/),
    ).toBeInTheDocument();
  });

  it('says a 429 is a refused read, and does not retry it', async () => {
    const fetchMock = vi.fn(async () => response({ status: { error_code: 429 } }, 429));
    vi.stubGlobal('fetch', fetchMock);
    renderChart();
    await waitFor(() => expect(screen.getByText(/HTTP 429/)).toBeInTheDocument());
    expect(screen.getByText(/Nothing is drawn from a refused read/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ChartPage when GeckoTerminal answers', () => {
  const BARS = [
    [T0, 1, 2, 0.5, 1.5, 100],
    [T0 + 4 * HOUR, 1.5, 1.8, 1.4, 1.7, 250],
  ];
  const META = {
    base: { symbol: 'TOWELI', address: TOWELI_MARKET.pool },
    quote: { symbol: 'WETH' },
  };

  function stubOk(bars = BARS, meta: unknown = META) {
    const fetchMock = vi.fn(async () => response(envelope(bars, meta)));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('draws one body per returned bucket and a hatched column for the ones that were not', async () => {
    stubOk();
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const svg = container.querySelector('svg')!;
    // Six bodies would mean the three missing hours had been filled in.
    expect(svg.querySelectorAll('g > rect')).toHaveLength(2);
    expect(svg.querySelectorAll('rect[fill="url(#candle-gap-hatch)"]')).toHaveLength(1);
    expect(screen.getByText(/3 buckets were not returned by the source/)).toBeInTheDocument();
  });

  it('takes its as-of from the source\'s newest bucket and says that bucket may still be open', async () => {
    stubOk();
    renderChart();
    await waitFor(() =>
      expect(screen.getByText(/Newest bucket opened \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/not this page's clock/)).toBeInTheDocument();
    // Unconditional: whether it is still filling depends on the source's clock,
    // which this page cannot see.
    expect(
      screen.getByText(/its close is the last trade GeckoTerminal had recorded when this page read it/),
    ).toBeInTheDocument();
  });

  it('marks only the newest body as possibly-open', async () => {
    stubOk();
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const titles = [...container.querySelectorAll('svg g > rect > title')].map((t) => t.textContent ?? '');
    expect(titles).toHaveLength(2);
    expect(titles[0]).not.toContain('bucket may still be open');
    expect(titles[1]).toContain('bucket may still be open');
  });

  it('never prints a trade count for a source that does not report one', async () => {
    stubOk();
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    // Mutation: `trades: 0` on a GeckoTerminal candle and this matches "0
    // trades" — a measurement nobody made, on a bucket with four real prices.
    expect(container.textContent ?? '').not.toMatch(/\d+\s+trades?\b/);
    expect(screen.getByText(/Trade counts are not reported by this source/)).toBeInTheDocument();
  });

  it('names the quote token the source named, and offers the same candles as a table', async () => {
    stubOk();
    renderChart();
    await waitFor(() => expect(screen.getByText('TOWELI / WETH')).toBeInTheDocument());
    // The plot is a shape; the table is the same slots in words, gaps included.
    expect(screen.getByText('Read these candles as a table')).toBeInTheDocument();
    expect(
      screen.getByText(/Not returned by the source — no price is claimed/),
    ).toBeInTheDocument();
  });

  it('says "unnamed upstream" rather than assuming WETH when the source sends no symbols', async () => {
    stubOk(BARS, undefined);
    renderChart();
    await waitFor(() =>
      expect(screen.getByText(/quote token \(unnamed upstream\)/)).toBeInTheDocument(),
    );
  });

  it('hands a regex-checked base address to the scanner, with the chain a 0x address needs', async () => {
    stubOk();
    renderChart();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Scan this token' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Scan this token' })).toHaveAttribute(
      'href',
      `/scan?token=${TOWELI_MARKET.pool}`,
    );
  });

  it('offers NO scan link when the address the source sent is not an address', async () => {
    stubOk(BARS, { base: { symbol: 'TOWELI', address: 'javascript:alert(1)' }, quote: { symbol: 'WETH' } });
    renderChart();
    await waitFor(() => expect(screen.getByText('TOWELI / WETH')).toBeInTheDocument());
    // Mutation: drop the regex gate and an upstream string lands in an href.
    expect(screen.queryByRole('link', { name: 'Scan this token' })).toBeNull();
  });

  it('reads the pool the reader picked, with Solana\'s case preserved', async () => {
    const fetchMock = stubOk();
    renderChart();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const bayla = poolButtons().find((b) => (b.textContent ?? '').includes('PumpSwap'));
    expect(bayla, 'the Solana resident should be offered').toBeDefined();
    fireEvent.click(bayla!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Mutation: lowercase a Solana pool anywhere on this path and the URL names
    // a DIFFERENT account — base58 is case-sensitive.
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/networks/solana/pools/8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n/ohlcv/',
    );
  });

  it('asks for the frame the reader picked', async () => {
    const fetchMock = stubOk();
    renderChart();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '4H' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/ohlcv/hour?aggregate=4');
  });

  it('says the window was empty at the SOURCE when no bucket comes back, and draws nothing', async () => {
    stubOk([], META);
    const { container } = renderChart();
    await waitFor(() =>
      expect(screen.getByText(/GeckoTerminal returned no bucket for this window/)).toBeInTheDocument(),
    );
    // Different screen, different sentence — and no bare axis.
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText(/not the price being zero/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here is a statement about this pool’s price/)).toBeNull();
  });
});

describe('ChartPage deep links', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => response(envelope([[T0, 1, 1, 1, 1, 1]]))));
  });

  it('opens the pool a good link names', async () => {
    const solana = chartableMarkets().find((m) => m.network === 'solana')!;
    renderChart(`/chart?network=solana&pool=${solana.pool}&tf=4h`);
    await waitFor(() => {
      const pressed = poolButtons().filter((b) => b.getAttribute('aria-pressed') === 'true');
      expect(pressed[0]?.textContent).toContain(solana.label);
    });
    expect(screen.getByRole('button', { name: '4H' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('refuses a pool it does not list, builds NO url from it, and puts it in no anchor', async () => {
    const hostile = '..%2F..%2Fsearch%2Fpools';
    const { container } = renderChart(`/chart?network=eth&pool=${hostile}`);
    await waitFor(() =>
      expect(screen.getByText(/The link named a pool this page does not list/)).toBeInTheDocument(),
    );

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    for (const call of fetchMock.mock.calls) {
      // Mutation: interpolate the parameter straight into ohlcvUrlFor and this
      // string reaches api.geckoterminal.com.
      expect(String(call[0])).not.toContain('search');
      expect(String(call[0])).not.toContain('%2F..');
    }
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toContain('search');
    }
  });

  it('refuses a network it does not offer instead of sending it to the source', async () => {
    renderChart('/chart?network=ethereum');
    await waitFor(() =>
      expect(screen.getByText(/named a network this page does not offer/)).toBeInTheDocument(),
    );
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    for (const call of fetchMock.mock.calls) {
      // 'ethereum' is this app's own word for the chain, and it 404s at
      // GeckoTerminal, whose slug is 'eth'.
      expect(String(call[0])).not.toContain('/networks/ethereum/');
    }
  });

  it('refuses a timeframe it does not offer rather than silently showing another one', async () => {
    renderChart('/chart?tf=1w');
    await waitFor(() =>
      expect(screen.getByText(/named a timeframe this page does not offer; showing 1H/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '1H' })).toHaveAttribute('aria-pressed', 'true');
  });
});
