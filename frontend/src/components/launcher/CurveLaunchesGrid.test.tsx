import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  CurveGridCardView,
  CurveLaunchesGridView,
  newestFirstSlice,
  CURVE_GRID_PAGE,
  type CurveGridCardData,
} from './CurveLaunchesGrid';

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> });
  return { m: { ...passthrough, div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>, section: ({ children, ...props }: { children?: React.ReactNode }) => <section {...props}>{children}</section> }, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});

const TOKEN = ('0x' + 'a'.repeat(40)) as `0x${string}`;

describe('newestFirstSlice', () => {
  it('fetches everything while under one page, the LAST page once over', () => {
    expect(newestFirstSlice(0n, CURVE_GRID_PAGE)).toEqual({ start: 0n, count: 0n });
    expect(newestFirstSlice(5n, CURVE_GRID_PAGE)).toEqual({ start: 0n, count: 5n });
    expect(newestFirstSlice(12n, 12)).toEqual({ start: 0n, count: 12n });
    // 13 launches, page 12: indices 1..12 — dropping index 0 (the OLDEST),
    // never index 12 (the newest). The off-by-one here is the silent bug class.
    expect(newestFirstSlice(13n, 12)).toEqual({ start: 1n, count: 12n });
    expect(newestFirstSlice(100n, 12)).toEqual({ start: 88n, count: 12n });
  });
});

function card(overrides: Partial<CurveGridCardData> = {}): CurveGridCardData {
  return {
    token: TOKEN,
    name: 'Towelie Jr',
    symbol: 'TWLJR',
    imageUrl: null,
    identityResolving: false,
    marketCapWei: 210526315789473684n,
    progressBps: 2500,
    graduated: false,
    planter: null,
    ...overrides,
  };
}

describe('CurveLaunchesGridView', () => {
  it('shows the honest empty state at zero launches, not a spinner', () => {
    render(
      <MemoryRouter>
        <CurveLaunchesGridView chainName="Base" launchCount={0n} tokens={[]} renderCard={() => null} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no launches on base yet/i)).toBeInTheDocument();
  });

  it('renders one card slot per token when launches exist', () => {
    const renderCard = vi.fn((t: `0x${string}`) => <div data-testid="slot">{t}</div>);
    render(
      <MemoryRouter>
        <CurveLaunchesGridView
          chainName="Base"
          launchCount={2n}
          tokens={[TOKEN, ('0x' + 'b'.repeat(40)) as `0x${string}`]}
          renderCard={renderCard}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId('slot')).toHaveLength(2);
    expect(renderCard).toHaveBeenCalledTimes(2);
  });
});

describe('CurveGridCardView', () => {
  it('links to the per-token page with the chain pinned in the query', () => {
    render(
      <MemoryRouter>
        <CurveGridCardView card={card()} chainId={8453} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /open towelie jr/i });
    expect(link).toHaveAttribute('href', `/eth-curve/${TOKEN}?c=8453`);
    expect(screen.getByText(/0\.2105 ETH cap/)).toBeInTheDocument();
  });

  it('graduated card shows the badge instead of a progress bar', () => {
    render(
      <MemoryRouter>
        <CurveGridCardView card={card({ graduated: true, marketCapWei: 0n })} chainId={1} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/graduated/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // Post-graduation the curve has no honest mcap — say so, never fabricate.
    expect(screen.getByText(/pool-priced/i)).toBeInTheDocument();
  });
});

// ── Element P: the planter's flame on the card (answer eight, ruling 11) ──
//
// The island ruled five states. Through the tape - the door the venue actually
// has - three of them are one observation, because the proxy drops any row
// without a handle and never sends is_cold. So the states that can be told
// apart are named, named-without-days, and absent, and the absent one renders
// NOTHING: never a zero, never "unnamed", which is the ruling's own hard law.
describe('element P: the planter on a launch card', () => {
  const planted = { xHandle: 'greencifer', tier: 'Builder', days: 214 };

  function line() {
    return document.querySelector('[data-element="p-planter"]');
  }

  it('names the planter, the tier and the days, separated by middle dots', () => {
    render(
      <MemoryRouter>
        <CurveGridCardView card={card({ planter: planted })} chainId={8453} />
      </MemoryRouter>,
    );
    // The middle dot is element N's separator for these same three facts, and
    // it keeps this line outside element I's em-dash budgets entirely.
    expect(line()?.textContent).toBe('Planted by @greencifer \u00b7 Builder \u00b7 214 days held');
    expect(line()?.textContent).not.toContain('\u2014');
  });

  it('prints the tier alone when the island sent no held-since', () => {
    render(
      <MemoryRouter>
        <CurveGridCardView card={card({ planter: { ...planted, days: null } })} chainId={8453} />
      </MemoryRouter>,
    );
    expect(line()?.textContent).toBe('Planted by @greencifer \u00b7 Builder');
    // A zero here would read as "planted today", which is a claim.
    expect(line()?.textContent).not.toContain('0 days');
  });

  it('prints the handle alone when the row carries no tier', () => {
    render(
      <MemoryRouter>
        <CurveGridCardView card={card({ planter: { xHandle: 'greencifer', tier: '', days: null } })} chainId={8453} />
      </MemoryRouter>,
    );
    expect(line()?.textContent).toBe('Planted by @greencifer');
  });

  it('renders NO line at all when the tape cannot name the planter', () => {
    // Unnamed-but-warm, cold, and an unreachable instrument arrive identically:
    // as no row. The card says nothing about the planter rather than guessing
    // which of the three it is.
    render(
      <MemoryRouter>
        <CurveGridCardView card={card({ planter: null })} chainId={8453} />
      </MemoryRouter>,
    );
    expect(line()).toBeNull();
    expect(screen.queryByText(/Planted by/)).toBeNull();
  });

  it('is dark until the first launch, because no card is built at zero', () => {
    // P ships behind data. The grid constructs no card at a zero count, so the
    // line cannot render before the venue has a launch to show it on.
    render(
      <MemoryRouter>
        <CurveLaunchesGridView chainName="Base" launchCount={0n} tokens={[]} renderCard={() => null} />
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-element="p-planter"]')).toBeNull();
  });
});
