// The trencher layer on the heat read (island answer twenty-four, build 7). SINCE: the read's
// since slot says which coin the clock started on, "In {coin} since {month year}.", and a
// room's read says it for the room's coin; the percentile form only once the island serves
// it. THE FLEX: under a warm read, the island's own card for the wallet, its picture and one
// press to its page; a cold read is handed nothing. Words are TRENCHER_WORDS and
// RECEIPT_WORDS, quoted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseHeatReading } from '../lib/heat/heatOracle';
import { RECEIPT_WORDS } from '../lib/arrival';

const ADDR = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const NOW = 1_788_700_000;
const AS_OF = NOW - 3600;
/** 2022-01-16 UTC. */
const HELD_SINCE = AS_OF - 1694 * 86_400;
/** 2025-08-02 UTC. */
const PEPE_SINCE = AS_OF - 400 * 86_400;

const h = vi.hoisted(() => ({ fetchHeat: vi.fn(), fetchFlames: vi.fn() }));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('../lib/heat/flamesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heat/flamesClient')>();
  return { ...actual, fetchFlames: (...args: unknown[]) => h.fetchFlames(...args) };
});
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../lib/heat/heatClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heat/heatClient')>();
  return { ...actual, fetchHeat: (...args: unknown[]) => h.fetchHeat(...args) };
});

const { HeatCard } = await import('./HeatCard');

function row(over: Record<string, unknown> = {}) {
  return {
    token_address: PEPE, chain: 'ethereum', name: 'Pepe', symbol: 'PEPE', heat_degrees: 338.21,
    first_seen_at_unix: PEPE_SINCE, last_transfer_at_unix: AS_OF - 86_400, retired: false, ...over,
  };
}

function wireReading(over: Record<string, unknown> = {}) {
  return parseHeatReading({
    address: ADDR, degrees: 1785.14, tier: 'Elder', is_cold: false, held_since_unix: HELD_SINCE, as_of_unix: AS_OF,
    token_count: 18, breakdown: [], observedAt: AS_OF, ...over,
  });
}

const COLD = { degrees: 0, tier: 'Drifter', is_cold: true, held_since_unix: null, as_of_unix: null, token_count: 0, x_handle: null };

const mount = () => render(<MemoryRouter><HeatCard address={ADDR} variant="embedded" /></MemoryRouter>);
const mountRoom = () =>
  render(
    <MemoryRouter>
      <HeatCard address={ADDR} variant="embedded" showEligibility={false} scopeTo={{ address: PEPE, symbol: 'PEPE' }} />
    </MemoryRouter>,
  );
/** The read has landed: the whole flame's served degrees are on the card in both forms. */
const landed = async (container: HTMLElement) => waitFor(() => expect(container.textContent ?? '').toContain('1785.14'));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  h.fetchFlames.mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('SINCE on the heat read', () => {
  it('names the coin the clock started on, in the since slot, between the degrees and the tokens', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row(), row({ token_address: '0x01', symbol: 'TOWELI', heat_degrees: 1200, first_seen_at_unix: HELD_SINCE })] }));
    const { container } = mount();
    const line = await screen.findByText('In TOWELI since January 2022.');
    const text = container.textContent ?? '';
    expect(text.indexOf('1785.14')).toBeLessThan(text.indexOf(line.textContent!));
    expect(text.indexOf(line.textContent!)).toBeLessThan(text.indexOf('18 tokens counted'));
    // The island's line takes the slot: the date is said once.
    expect(text).not.toContain('on the island since');
  });

  it('carries the percentile once the island serves it beside held_since_unix', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ earlier_than_pct: 93.2, breakdown: [row({ first_seen_at_unix: HELD_SINCE })] }));
    mount();
    expect(await screen.findByText("In PEPE since January 2022, earlier than 93% of today's holders.")).toBeTruthy();
  });

  it('keeps the old line when no served row carries held_since_unix, since the coin is unknown', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row()] }));
    const { container } = mount();
    await landed(container);
    expect(container.textContent).toContain('on the island since January 2022');
    expect(container.textContent).not.toMatch(/\bIn [A-Z]+ since /);
  });
});

describe('SINCE in a room', () => {
  it('says the room’s coin and the month its clock started, as its own line', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row()] }));
    const { container } = mountRoom();
    expect(await screen.findByText('In PEPE since August 2025.')).toBeTruthy();
    expect(container.textContent).toContain('400 days held');
    // Said once: the days line no longer repeats the month.
    expect(container.textContent).not.toContain('· since');
  });

  it('carries the percentile only when the room’s coin is the one held_since_unix belongs to', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ earlier_than_pct: 93.2, breakdown: [row({ first_seen_at_unix: HELD_SINCE })] }));
    const first = mountRoom();
    expect(await screen.findByText("In PEPE since January 2022, earlier than 93% of today's holders.")).toBeTruthy();
    first.unmount();

    h.fetchHeat.mockResolvedValue(wireReading({ earlier_than_pct: 93.2, breakdown: [row()] }));
    const { container } = mountRoom();
    expect(await screen.findByText('In PEPE since August 2025.')).toBeTruthy();
    expect(container.textContent).not.toContain('earlier than');
  });

  it('says nothing of the kind for a wallet with no row in the room, even when another coin names held_since_unix', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row({ token_address: '0xother', symbol: 'OTHER', first_seen_at_unix: HELD_SINCE })] }));
    const { container } = mountRoom();
    await screen.findByText('This wallet holds no measured PEPE yet.');
    expect(container.textContent).not.toMatch(/\bIn [A-Z]+ since /);
  });
});

describe('THE FLEX: the island’s card under a warm read', () => {
  const card = () => screen.findByRole('link', { name: RECEIPT_WORDS.share });

  it('hands over the island’s card: its picture, and one press to its page', async () => {
    h.fetchHeat.mockResolvedValue(wireReading());
    mount();
    const link = await card();
    expect(link).toHaveAttribute('href', `https://memetics.wtf/card/${ADDR}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const img = link.querySelector('img')!;
    expect(img).toHaveAttribute('src', `https://memetics.wtf/api/card?w=${ADDR}`);
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('hands it over in a room too', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row()] }));
    mountRoom();
    expect(await card()).toHaveAttribute('href', `https://memetics.wtf/card/${ADDR}`);
  });

  it('a cold read is handed nothing', async () => {
    h.fetchHeat.mockResolvedValue(wireReading(COLD));
    mount();
    await screen.findByText(/Cold\. Nothing measured here yet\./);
    expect(screen.queryByRole('link', { name: RECEIPT_WORDS.share })).toBeNull();
    expect(document.querySelector('img[src*="memetics.wtf/api/card"]')).toBeNull();
  });

  it('a picture that does not load leaves the press, never a broken image', async () => {
    h.fetchHeat.mockResolvedValue(wireReading());
    mount();
    const link = await card();
    fireEvent.error(link.querySelector('img')!);
    expect(link.querySelector('img')).toBeNull();
    expect(link).toHaveAttribute('href', `https://memetics.wtf/card/${ADDR}`);
  });
});
