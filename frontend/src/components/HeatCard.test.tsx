// HeatCard — the instrument's rendered reading. This component had NO test at all
// before wave seven, which is why a recut of its result area could otherwise have
// shipped on a green suite that never looked at it.
//
// What is pinned here is the ISLAND'S ORDER and its two honesty states:
//   tier · days · degrees · since · tokens, in that order, because the order is the
//   design (a word first, then the unit anyone can compare, then the island's grammar);
//   a COLD read that names where the clock starts instead of showing a zero-shaped
//   ladder; and a NAMED flame whose byline can only ever link to an x.com profile.
//
// THE CLOCK IS PINNED. Every figure below is absolute, and `Date.now` is mocked to one
// instant, so the reading can never age past the 7-day staleness gate and turn this
// suite red in a week. A fixture that rots is not a fixture.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseHeatReading } from '../lib/heat/heatOracle';

const ADDR = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';

// Pinned instant, and the spec's own worked example hung off it: 1694 days held,
// +2.3° since Sep 3.
const NOW = 1_788_700_000;
const AS_OF = NOW - 3600;
const HELD_SINCE = AS_OF - 1694 * 86_400;
const PRIOR_AS_OF = AS_OF - 3 * 86_400;
const DEGREES = 1785.14;
const PRIOR_DEGREES = 1782.84;

const h = vi.hoisted(() => ({
  address: undefined as string | undefined,
  fetchHeat: vi.fn(),
  fetchFlames: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.address }),
}));

// Only the network call is stubbed; insertionRank is pure and stays real, so the
// rank the card paints is the one the shipped arithmetic produces.
vi.mock('../lib/heat/flamesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heat/flamesClient')>();
  return { ...actual, fetchFlames: (...args: unknown[]) => h.fetchFlames(...args) };
});

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

const { HeatCard } = await import('./HeatCard');

function wireReading(over: Record<string, unknown> = {}) {
  return parseHeatReading({
    address: ADDR,
    degrees: DEGREES,
    tier: 'Elder',
    is_cold: false,
    held_since_unix: HELD_SINCE,
    as_of_unix: AS_OF,
    token_count: 18,
    breakdown: [],
    observedAt: AS_OF,
    ...over,
  });
}

function mount() {
  return render(
    <MemoryRouter>
      <HeatCard address={ADDR} variant="embedded" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  h.address = undefined;
  h.fetchHeat.mockResolvedValue(wireReading());
  // Default: the island's board is off, so the rank line is absent unless a test
  // deliberately turns the board on.
  h.fetchFlames.mockResolvedValue(null);
});

/** A board of five flames, four of them ahead of `degrees`. */
function boardAhead(degrees: number) {
  return {
    flames: [4, 3, 2, 1].map((n) => ({
      xHandle: `holder${n}`,
      degrees: degrees + n,
      tier: 'Elder',
      heldSinceUnix: HELD_SINCE,
      tokenCount: 3,
    })).concat([
      { xHandle: 'behind', degrees: degrees - 1, tier: 'Builder', heldSinceUnix: HELD_SINCE, tokenCount: 1 },
    ]),
    asOfUnix: AS_OF,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the read, in the island’s order', () => {
  it('paints tier, days, degrees, since and tokens IN THAT ORDER', async () => {
    const { container } = mount();
    await screen.findByText('Elder');

    const text = container.textContent ?? '';
    const iTier = text.indexOf('Elder');
    const iDays = text.indexOf('1,694');
    const iDegrees = text.indexOf('1785.14');
    const iSince = text.indexOf('January 2022');
    const iTokens = text.indexOf('18 tokens counted');

    for (const [name, i] of Object.entries({ iTier, iDays, iDegrees, iSince, iTokens })) {
      expect(i, `${name} is missing from the card`).toBeGreaterThanOrEqual(0);
    }
    expect(iTier).toBeLessThan(iDays);
    expect(iDays).toBeLessThan(iDegrees);
    expect(iDegrees).toBeLessThan(iSince);
    expect(iSince).toBeLessThan(iTokens);
  });

  it('counts the days the ISLAND measured, held_since to as_of, not to our clock', async () => {
    // Our clock is an hour past the reckoning. If the card counted to `now` it would
    // read 1694 here too, so make the gap a full day to tell the two apart.
    h.fetchHeat.mockResolvedValue(wireReading({ as_of_unix: NOW - 86_400 }));
    mount();
    // 1694 days ended one day EARLIER than as_of, so the span is one day shorter.
    expect(await screen.findByText('1,693')).toBeTruthy();
  });

  it('renders the tier word verbatim, never restyled into yield language', async () => {
    mount();
    const tier = await screen.findByText('Elder');
    expect(tier.textContent).toBe('Elder');
  });
});

describe('the delta — arithmetic on two served numbers', () => {
  it('prints nothing on the first read of an address', async () => {
    const { container } = mount();
    await screen.findByText('Elder');
    expect(container.textContent).not.toContain('since Sep');
    expect(container.textContent).not.toContain('unchanged');
  });

  it('remembers this read, so the NEXT one can compare', async () => {
    mount();
    await screen.findByText('Elder');
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('tf_heat_last_read') ?? '{}');
      expect(stored[ADDR]).toEqual({ degrees: DEGREES, asOf: AS_OF });
    });
  });

  it('prints the rise with its sign and the date it is measured from', async () => {
    localStorage.setItem(
      'tf_heat_last_read',
      JSON.stringify({ [ADDR]: { degrees: PRIOR_DEGREES, asOf: PRIOR_AS_OF } }),
    );
    mount();
    expect(await screen.findByText('+2.3° since Sep 3')).toBeTruthy();
  });

  it('prints a fall with a minus, never as a rise', async () => {
    localStorage.setItem(
      'tf_heat_last_read',
      JSON.stringify({ [ADDR]: { degrees: DEGREES + 5, asOf: PRIOR_AS_OF } }),
    );
    mount();
    expect(await screen.findByText('-5.0° since Sep 3')).toBeTruthy();
  });

  it('says unchanged rather than +0.0° when the number has not moved', async () => {
    localStorage.setItem(
      'tf_heat_last_read',
      JSON.stringify({ [ADDR]: { degrees: DEGREES, asOf: PRIOR_AS_OF } }),
    );
    mount();
    expect(await screen.findByText('unchanged since Sep 3')).toBeTruthy();
  });

  it('survives unreadable storage without showing the visitor an error', async () => {
    localStorage.setItem('tf_heat_last_read', 'not json{{{');
    const { container } = mount();
    await screen.findByText('Elder');
    expect(container.textContent).not.toContain('since Sep');
  });
});

describe('the cold read — the most important copy on the site', () => {
  beforeEach(() => {
    h.fetchHeat.mockResolvedValue(
      wireReading({ degrees: 0, tier: 'Drifter', is_cold: true, held_since_unix: null, as_of_unix: null, token_count: 0 }),
    );
  });

  it('says where the clock STARTS instead of showing a zero', async () => {
    mount();
    expect(
      await screen.findByText(/Cold\. Nothing measured here yet\./),
    ).toBeTruthy();
  });

  it('offers the hall as the one thing to do', async () => {
    mount();
    const link = await screen.findByRole('link', { name: 'Pick a bungalow' });
    expect(link.getAttribute('href')).toBe('/#hall');
  });

  it('shows neither a ladder nor a delta on a cold read', async () => {
    localStorage.setItem(
      'tf_heat_last_read',
      JSON.stringify({ [ADDR]: { degrees: PRIOR_DEGREES, asOf: PRIOR_AS_OF } }),
    );
    const { container } = mount();
    await screen.findByText(/Cold\. Nothing measured here yet\./);
    expect(container.textContent).not.toContain('Toward');
    expect(container.textContent).not.toContain('since Sep');
  });
});

describe('the name, or the door', () => {
  it.each(['@_seacasa', '_seacasa'])(
    'paints %s as exactly one @_seacasa linking to the profile',
    async (served) => {
      h.fetchHeat.mockResolvedValue(wireReading({ x_handle: served }));
      mount();
      const link = await screen.findByRole('link', { name: '@_seacasa' });
      expect(link.getAttribute('href')).toBe('https://x.com/_seacasa');
      expect(link.textContent).toBe('@_seacasa'); // one @, never '@@'
    },
  );

  it('sends a named flame to the board', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: '@_seacasa' }));
    mount();
    const board = await screen.findByRole('link', { name: 'On the board.' });
    expect(board.getAttribute('href')).toBe('https://memetics.wtf/flames');
  });

  it('offers the door to an unnamed flame, with no apology', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: null }));
    mount();
    expect(await screen.findByText(/No name on this flame yet\./)).toBeTruthy();
    const door = screen.getByRole('link', { name: 'Put yours on it' });
    expect(door.getAttribute('href')).toBe('https://memetics.wtf/register');
  });

  it('refuses a spoofed handle by falling back to the door, never a bad href', async () => {
    // normalizeXHandle rejects it upstream; the card must then read as unnamed
    // rather than painting a link to somewhere that is not x.com.
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: '//evil.example' }));
    const { container } = mount();
    await screen.findByText(/No name on this flame yet\./);
    expect(container.innerHTML).not.toContain('evil.example');
  });

  it('shows neither a name nor a door on a cold read', async () => {
    h.fetchHeat.mockResolvedValue(
      wireReading({ degrees: 0, tier: 'Drifter', is_cold: true, held_since_unix: null, as_of_unix: null, token_count: 0, x_handle: null }),
    );
    const { container } = mount();
    await screen.findByText(/Cold\. Nothing measured here yet\./);
    expect(container.textContent).not.toContain('No name on this flame yet');
  });
});

describe('where this number would sit', () => {
  it('places an unnamed flame against the whole board', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: null }));
    h.fetchFlames.mockResolvedValue(boardAhead(DEGREES));
    mount();
    // Four flames beat it, so it inserts at #5, and the board grows to 6 with it in.
    expect(
      await screen.findByText(/would\s+sit at #5 of 6\./),
    ).toBeTruthy();
  });

  it('reads the WHOLE board, not just the named part', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: null }));
    h.fetchFlames.mockResolvedValue(boardAhead(DEGREES));
    mount();
    await screen.findByText(/would\s+sit at #5 of 6\./);
    // claimed is NOT set: a rank against named flames only would flatter the number.
    expect(h.fetchFlames).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
    expect(h.fetchFlames.mock.calls[0][0]).not.toHaveProperty('claimed', true);
  });

  it('says nothing for a NAMED flame — the island states their real position', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: '@_seacasa' }));
    h.fetchFlames.mockResolvedValue(boardAhead(DEGREES));
    const { container } = mount();
    await screen.findByRole('link', { name: '@_seacasa' });
    expect(container.textContent).not.toContain('would sit at');
    expect(h.fetchFlames).not.toHaveBeenCalled();
  });

  it('is absent when the island’s board is off', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: null }));
    h.fetchFlames.mockResolvedValue(null);
    const { container } = mount();
    await screen.findByText(/No name on this flame yet\./);
    expect(container.textContent).not.toContain('would sit at');
  });

  it('is absent when the board is unreachable, never a guessed position', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ x_handle: null }));
    h.fetchFlames.mockRejectedValue(new Error('unreachable'));
    const { container } = mount();
    await screen.findByText(/No name on this flame yet\./);
    expect(container.textContent).not.toContain('would sit at');
  });

  it('never asks the board about a cold wallet', async () => {
    h.fetchHeat.mockResolvedValue(
      wireReading({ degrees: 0, tier: 'Drifter', is_cold: true, held_since_unix: null, as_of_unix: null, token_count: 0, x_handle: null }),
    );
    mount();
    await screen.findByText(/Cold\. Nothing measured here yet\./);
    expect(h.fetchFlames).not.toHaveBeenCalled();
  });
});

describe('the share', () => {
  it('builds the post from served numbers, ending in the read link', async () => {
    mount();
    const post = await screen.findByRole('link', { name: 'Post my number' });
    const text = new URL(post.getAttribute('href') ?? '').searchParams.get('text');
    expect(text).toBe(
      `Elder. 1694 days held. 1785.1° on Jungle Bay Island's instrument. ` +
        `Held time counts here. https://memetics.finance/read/${ADDR}`,
    );
  });

  it('opens the composer rather than posting anything', async () => {
    mount();
    const post = await screen.findByRole('link', { name: 'Post my number' });
    expect(post.getAttribute('href')).toMatch(/^https:\/\/x\.com\/intent\/post\?text=/);
  });

  it('offers NO share on a cold read', async () => {
    h.fetchHeat.mockResolvedValue(
      wireReading({ degrees: 0, tier: 'Drifter', is_cold: true, held_since_unix: null, as_of_unix: null, token_count: 0 }),
    );
    mount();
    await screen.findByText(/Cold\. Nothing measured here yet\./);
    expect(screen.queryByRole('link', { name: 'Post my number' })).toBeNull();
  });
});

describe('a shared link arrives already reading', () => {
  function mountShared(address: string) {
    return render(
      <MemoryRouter>
        <HeatCard variant="embedded" initialAddress={address} />
      </MemoryRouter>,
    );
  }

  it('reads the seeded address on mount, with no click', async () => {
    mountShared(ADDR);
    expect(await screen.findByText('Elder')).toBeTruthy();
    expect(h.fetchHeat).toHaveBeenCalledWith(ADDR, expect.anything());
  });

  it('leaves the field editable, unlike a pinned card', async () => {
    // Someone who followed a stranger's number should be one paste from their own.
    const { container } = mountShared(ADDR);
    await screen.findByText('Elder');
    const field = container.querySelector('input');
    expect(field).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe(ADDR);
  });

  it('lets an invalid seeded address read as the field’s own invalid state', async () => {
    h.fetchHeat.mockRejectedValue(new Error('That is not an Ethereum or Solana address.'));
    const { container } = mountShared('not-an-address');
    await waitFor(() => expect(h.fetchHeat).toHaveBeenCalled());
    // The bad value is shown back rather than silently swallowed.
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('not-an-address');
  });
});
