import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildCandleSeries } from '../../lib/chart/candles';
import { CandleChart } from './CandleChart';
import { ChartStatus } from './ChartStatus';

const HOUR = 3600;

function trade(hourOffset: number, price: number, volume = 1) {
  return { timeSec: hourOffset * HOUR, price, volume };
}

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no chart was rendered');
  return svg as SVGSVGElement;
}

describe('CandleChart draws the gaps', () => {
  const series = buildCandleSeries([trade(0, 10), trade(4, 20)], HOUR, { truncated: false });

  it('renders one body per traded bucket and no body for an empty one', () => {
    const { container } = render(<CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    const svg = svgOf(container);
    // Two candle bodies. Six would mean the three empty hours had been filled.
    const bodies = svg.querySelectorAll('g > rect');
    expect(bodies).toHaveLength(2);
  });

  it('paints the empty hours with the gap hatch rather than leaving them indistinguishable', () => {
    const { container } = render(<CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    const gaps = svgOf(container).querySelectorAll('rect[fill="url(#candle-gap-hatch)"]');
    expect(gaps).toHaveLength(1);
  });

  it('says in its own tooltip that no price is claimed for the gap', () => {
    const { container } = render(<CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    const title = svgOf(container).querySelector('rect[fill="url(#candle-gap-hatch)"] title')!;
    expect(title.textContent).toContain('No trade');
    expect(title.textContent).toContain('no price is claimed');
  });

  it('tells assistive tech how many buckets were empty, in the same words', () => {
    const { container } = render(<CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    const label = svgOf(container).getAttribute('aria-label')!;
    expect(label).toContain('3 buckets had no trade at all');
    expect(label).toContain('drawn as gaps rather than filled in');
  });

  it('names which token is priced in which, so the axis is not ambiguous', () => {
    render(<CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    expect(screen.getByText('TOWELI priced in WETH')).toBeInTheDocument();
  });
});

describe('CandleChart with nothing drawable', () => {
  it('states that the window was empty instead of drawing a bare axis', () => {
    const empty = buildCandleSeries([], HOUR, { truncated: false });
    const { container } = render(<CandleChart series={empty} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText(/no candle to draw/i)).toBeInTheDocument();
    // A blank plot area would read as a price of zero. The words are the fix.
    expect(screen.getByText(/not the price being zero/i)).toBeInTheDocument();
  });
});

describe('ChartStatus is the answer in every non-ready state', () => {
  const base = {
    detail: null,
    series: null,
    swapsRead: 0,
    unpriceable: 0,
    truncated: false,
    syncedAt: null,
    onRetry: () => {},
  };

  it('refuses to let an outage read as a market that did not trade', () => {
    render(<ChartStatus {...base} status="unavailable" detail="The indexer did not answer in time." />);
    expect(screen.getByText('The candle history is unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Nothing here is a statement about this pool’s price/)).toBeInTheDocument();
  });

  it('explains why a backfilling indexer gets no plot at all', () => {
    render(<ChartStatus {...base} status="backfilling" detail="Still replaying history." />);
    expect(screen.getByText(/No candles are drawn while the indexer is catching up/)).toBeInTheDocument();
  });

  it('states the coverage of a ready series rather than implying it is complete', () => {
    const series = buildCandleSeries([trade(0, 10), trade(1, 11), trade(5, 12)], HOUR, { truncated: true });
    render(
      <ChartStatus
        {...base}
        status="ready"
        series={series}
        swapsRead={100}
        unpriceable={2}
        truncated
      />,
    );
    expect(screen.getByText(/100 indexed swaps read/)).toBeInTheDocument();
    expect(screen.getByText(/Older swaps exist behind this page/)).toBeInTheDocument();
    expect(screen.getByText(/oldest bucket was cut by that page boundary/)).toBeInTheDocument();
    expect(screen.getByText(/2 rows could not be priced/)).toBeInTheDocument();
    expect(screen.getByText(/drawn as gaps — no price is invented across them/)).toBeInTheDocument();
  });

  it('offers a retry only where retrying is the right move', () => {
    const { rerender } = render(<ChartStatus {...base} status="loading" />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<ChartStatus {...base} status="unavailable" />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

// ── The GeckoTerminal shape ────────────────────────────────────────────────
//
// A pre-aggregated bucket reports no trade count and its newest one may still be
// filling. Both are things the indexed path never has to say, and both are
// places a renderer can invent a fact: "0 trades" for a count nobody took, and a
// closed-looking candle for a bucket that is still open.

describe('CandleChart on a source that reports no trade count', () => {
  function geckoSeries() {
    const built = buildCandleSeries([trade(0, 10), trade(4, 20)], HOUR, { truncated: false });
    return {
      ...built,
      slots: built.slots.map((s) => (s.kind === 'candle' ? { ...s, trades: null } : s)),
    };
  }

  it('omits the trade clause entirely rather than printing a zero', () => {
    const { container } = render(
      <CandleChart series={geckoSeries()} baseSymbol="TOWELI" quoteSymbol="WETH" />,
    );
    const titles = [...svgOf(container).querySelectorAll('g > rect > title')].map((t) => t.textContent ?? '');
    expect(titles).toHaveLength(2);
    for (const title of titles) {
      // Mutation: interpolate `trades` unguarded and these read "· null trades";
      // default it to 0 and they claim a measurement nobody made.
      expect(title).not.toMatch(/trade/);
      expect(title).toContain('O ');
    }
  });

  it('still prints a real count on the indexed path', () => {
    const built = buildCandleSeries([trade(0, 10), trade(4, 20)], HOUR, { truncated: false });
    const { container } = render(<CandleChart series={built} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    const title = svgOf(container).querySelector('g > rect > title')!;
    expect(title.textContent).toContain('1 trade');
  });

  it('marks ONLY the newest body as possibly still open, and only when asked', () => {
    const series = geckoSeries();
    const off = render(<CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" />);
    for (const t of svgOf(off.container).querySelectorAll('g > rect > title')) {
      expect(t.textContent).not.toContain('may still be open');
    }
    off.unmount();

    const on = render(
      <CandleChart series={series} baseSymbol="TOWELI" quoteSymbol="WETH" newestMayBeOpen />,
    );
    const svg = svgOf(on.container);
    const titles = [...svg.querySelectorAll('g > rect > title')].map((t) => t.textContent ?? '');
    // Mutation: mark every body and the whole chart reads as provisional; mark
    // the last SLOT instead of the last CANDLE and a series ending on a gap
    // marks nothing at all.
    expect(titles[0]).not.toContain('bucket may still be open');
    expect(titles[1]).toContain('bucket may still be open');
    expect(svg.querySelectorAll('g > rect[stroke-dasharray]')).toHaveLength(1);
    expect(svg.getAttribute('aria-label')).toContain('The newest bucket may still be open.');
  });
});

describe('ChartStatus on the GeckoTerminal branch', () => {
  const market = { network: 'eth' as const, pool: '0xabc', label: 'TOWELI' };

  function geckoState(overrides: Record<string, unknown> = {}) {
    return {
      status: 'ready' as const,
      reason: null,
      series: null,
      baseSymbol: 'TOWELI',
      quoteSymbol: 'WETH',
      baseAddress: null,
      barsRead: 0,
      limit: 240,
      httpStatus: 200,
      detail: null,
      reload: () => {},
      ...overrides,
    };
  }

  it('says a capped read may hide older buckets — never that a bucket was cut', () => {
    const built = buildCandleSeries([trade(0, 10), trade(4, 20)], HOUR, { truncated: false });
    const series = {
      ...built,
      zeroVolumeBars: 1,
      duplicates: 2,
      newestStartSec: 4 * HOUR,
      capped: true,
    };
    render(
      <ChartStatus
        source="gecko"
        market={market}
        timeframeLabel="1H"
        state={geckoState({ series, barsRead: 2 }) as never}
      />,
    );
    expect(screen.getByText(/This read was capped at 240 buckets/)).toBeInTheDocument();
    expect(screen.getByText(/older buckets may exist behind the left edge/)).toBeInTheDocument();
    // The indexed path's truncation sentence must never appear here: nothing was
    // cut, because the source returns whole buckets.
    expect(screen.queryByText(/cut by that page boundary/)).toBeNull();
    expect(screen.getByText(/zero reported volume/)).toBeInTheDocument();
    expect(screen.getByText(/2 duplicate timestamps were returned/)).toBeInTheDocument();
  });

  it('prints the not-a-zero sentence on every refusal, and offers a retry', () => {
    for (const reason of ['rate-limited', 'not-found', 'http', 'off-schema', 'off-grid', 'network'] as const) {
      const view = render(
        <ChartStatus
          source="gecko"
          market={market}
          timeframeLabel="1H"
          state={geckoState({ status: 'unavailable', reason, series: null, httpStatus: 500 }) as never}
        />,
      );
      expect(screen.getByText('The candle history is unavailable')).toBeInTheDocument();
      expect(
        screen.getByText(/Nothing here is a statement about this pool’s price/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      view.unmount();
    }
  });
});
