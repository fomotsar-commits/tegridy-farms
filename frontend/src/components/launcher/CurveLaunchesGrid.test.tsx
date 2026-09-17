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

// ── Element P: the planter's flame, five states (answer nine) ──────────
//
// Session nine could ship four: the tape returned null for anything without a
// handle, so an unnamed-but-warm planter, a cold one and an unreachable
// instrument were one observation. Answer nine put is_cold on the row and made
// an unnamed flame answer WITH a row, so all five are distinguishable now. The
// fifth - no row at all - still renders nothing, because a failed read is not a
// fact about a planter.
describe('element P: the planter on a launch card', () => {
  const PLANTER = '0x12345678901234567890123456789012345abcd0';
  const named = { xHandle: 'greencifer', isCold: false, tier: 'Builder', days: 214 };

  function line() {
    return document.querySelector('[data-element="p-planter"]');
  }
  function show(planter: CurveGridCardData['planter']) {
    render(
      <MemoryRouter>
        <CurveGridCardView card={card({ planter })} chainId={8453} />
      </MemoryRouter>,
    );
  }

  it('names the planter, the tier and the days, separated by middle dots', () => {
    show({ address: PLANTER, row: named });
    // The middle dot is element N's separator for these same three facts, and
    // it keeps this line outside element I's em-dash budgets entirely.
    expect(line()?.textContent).toBe('Planted by @greencifer \u00b7 Builder \u00b7 214 days held');
    expect(line()?.textContent).not.toContain('\u2014');
  });

  it("puts the island's door OUTSIDE the card's own link, not inside it", () => {
    // The door and the card are both links, and the card used to wrap the door.
    // An <a> inside an <a> is invalid HTML: React warns, and any path that
    // PARSES this markup rather than constructing it (pre-render, hydration)
    // closes the outer anchor early, which puts the card's click target
    // somewhere nobody chose. The card is a container with a stretched link now.
    show({ address: PLANTER, row: { xHandle: null, isCold: false, tier: '', days: null } });
    const door = screen.getByRole('link', { name: 'Put yours on it' });
    const card = screen.getByRole('link', { name: /on the curve$/ });
    expect(door.closest('a')).toBe(door);
    expect(card.contains(door)).toBe(false);
    // And the card is still one link over the whole card, not a bare div.
    expect(card.className).toContain('absolute');
  });

  it('prints the tier alone when the island sent no held-since', () => {
    show({ address: PLANTER, row: { ...named, days: null } });
    expect(line()?.textContent).toBe('Planted by @greencifer \u00b7 Builder');
    // A zero here would read as "planted today", which is a claim.
    expect(line()?.textContent).not.toContain('0 days');
  });

  it('offers the door when the flame is warm but unnamed', () => {
    show({ address: PLANTER, row: { xHandle: null, isCold: false, tier: '', days: null } });
    expect(line()?.textContent).toContain('Planted by a flame with no name yet.');
    const door = screen.getByRole('link', { name: 'Put yours on it' });
    expect(door).toHaveAttribute('href', 'https://memetics.wtf/register');
    // No standing beside an unnamed flame: that is the tape's own law, and the
    // wire does not even carry it.
    expect(line()?.textContent).not.toContain('Builder');
    expect(line()?.textContent).not.toContain('days held');
  });

  it('names a COLD planter by address, and claims no held time', () => {
    show({ address: PLANTER, row: { xHandle: null, isCold: true, tier: '', days: null } });
    // shortenAddress is the venue's house form: first six, last four.
    expect(line()?.textContent).toBe('Planted by 0x1234...bcd0. No held time on the island yet.');
    // Cold is not unnamed: the two were the same absence until answer nine.
    expect(line()?.textContent).not.toContain('no name yet');
  });

  it('renders NO line at all when there is no row for the planter', () => {
    // A failed read, or an address the island refused. Not a cold planter, and
    // the card says nothing rather than guessing which.
    show(null);
    expect(line()).toBeNull();
    expect(screen.queryByText(/Planted by/)).toBeNull();
  });

  it('is dark until the first launch, because no card is built at zero', () => {
    render(
      <MemoryRouter>
        <CurveLaunchesGridView chainName="Base" launchCount={0n} tokens={[]} renderCard={() => null} />
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-element="p-planter"]')).toBeNull();
  });
});
