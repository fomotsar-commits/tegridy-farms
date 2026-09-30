// HeatCard, the instrument's rendered reading. Pinned: the island's order (tier, days,
// degrees, since, tokens), a COLD read that names where the clock starts, a named flame
// that links only to an x.com profile, the served tier word, and the island's sentences.
// Date.now is mocked to one instant, so no fixture ages past the 7-day freshness law.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseHeatReading } from '../lib/heat/heatOracle';
import { VENUE } from '../lib/arrival';

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
  supported: true,
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
  isSupportedHeatAddress: () => h.supported,
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
  h.supported = true;
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

/** Wait for the reading to land. The tier word renders twice (headline and ladder rung),
 *  so the barrier is the FIRST match: the headline, which renders before the ladder. */
async function awaitRead(tier = 'Elder'): Promise<HTMLElement> {
  const all = await screen.findAllByText(tier);
  return all[0]!;
}

describe('the read, in the island’s order', () => {
  it('paints tier, days, degrees, since and tokens IN THAT ORDER', async () => {
    const { container } = mount();
    await awaitRead();

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
    // EVERY place the word renders, not just the first: the ladder repeats it,
    // and a rung that said "Elder tier" or "Elder (max)" would be exactly the
    // restyling this pins against.
    const all = await screen.findAllByText('Elder');
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const el of all) expect(el.textContent).toBe('Elder');
  });
});

describe('the delta — arithmetic on two served numbers', () => {
  it('prints nothing on the first read of an address', async () => {
    const { container } = mount();
    await awaitRead();
    expect(container.textContent).not.toContain('since Sep');
    expect(container.textContent).not.toContain('unchanged');
  });

  it('remembers this read, so the NEXT one can compare', async () => {
    mount();
    await awaitRead();
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
    await awaitRead();
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
    const cold = await screen.findByText(/Cold\. Nothing measured here yet\./);
    // The island's words: the clock starts at a first HOLD, which a gift or an airdrop is too.
    expect(cold.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Cold. Nothing measured here yet. Your clock on a token starts at your first hold.',
    );
  });

  // The freshness strip is prose on the venue home, a route held at zero em dashes, and
  // only a read puts it on screen, so the route's own ratchet never sees it.
  it('says it was never reckoned without a prose em dash', async () => {
    mount();
    const line = await screen.findByText(/^Reckoned: never/);
    expect(line.textContent).toBe('Reckoned: never. This wallet has no measured holdings');
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

  it('posts the served tier word, even where the bands would name another', async () => {
    // 95° sits in the Resident band; the island served Observer, so the post says Observer.
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 95, tier: 'Observer' }));
    mount();
    const post = await screen.findByRole('link', { name: 'Post my number' });
    const text = new URL(post.getAttribute('href') ?? '').searchParams.get('text');
    expect(text).toBe(
      `Observer. 1694 days held. 95.0° on Jungle Bay Island's instrument. ` +
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
    expect(await awaitRead()).toBeTruthy();
    expect(h.fetchHeat).toHaveBeenCalledWith(ADDR, expect.anything());
  });

  it('leaves the field editable, unlike a pinned card', async () => {
    // Someone who followed a stranger's number should be one paste from their own.
    const { container } = mountShared(ADDR);
    await awaitRead();
    const field = container.querySelector('input');
    expect(field).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe(ADDR);
  });

  it('lets an invalid seeded address read as the field’s own invalid state', async () => {
    h.fetchHeat.mockRejectedValue(new Error('That is not an Ethereum, Base, or Solana address.'));
    const { container } = mountShared('not-an-address');
    await waitFor(() => expect(h.fetchHeat).toHaveBeenCalled());
    // The bad value is shown back rather than silently swallowed.
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('not-an-address');
  });
});

// ANSWER TEN, RULING 2: a value typed into the venue's first frame and NOT submitted
// arrives as a draft. The first version handed it over as `initialAddress`, which
// reads on mount, so a half-typed address raised the instrument's error panel for a
// read nobody asked for.
describe('a draft typed before the card existed', () => {
  function mountDraft(props: { initialDraft?: string | null; initialAddress?: string | null; focusField?: boolean }) {
    return render(
      <MemoryRouter>
        <HeatCard variant="embedded" {...props} />
      </MemoryRouter>,
    );
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('is put in the field and not read: nobody submitted it', async () => {
    const { container } = mountDraft({ initialDraft: '0xd71caf9f' });
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('0xd71caf9f');
    await settle();
    expect(h.fetchHeat).not.toHaveBeenCalled();
  });

  it('holds back the connected wallet’s auto-read too, as typing does', async () => {
    h.address = ADDR;
    mountDraft({ initialDraft: '0xd71caf9f' });
    await settle();
    expect(h.fetchHeat).not.toHaveBeenCalled();
  });

  it('reads when it is submitted', async () => {
    const { container } = mountDraft({ initialDraft: ADDR });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(h.fetchHeat).toHaveBeenCalledWith(ADDR, expect.anything()));
  });

  it('still reads an untouched ?heat= prefill on arrival', async () => {
    mountDraft({ initialDraft: ADDR, initialAddress: ADDR });
    await waitFor(() => expect(h.fetchHeat).toHaveBeenCalledWith(ADDR, expect.anything()));
  });

  it('takes focus only when the field it replaced had it', () => {
    const first = mountDraft({ initialDraft: '0xd7', focusField: true });
    expect(document.activeElement).toBe(first.container.querySelector('input'));
    first.unmount();
    const second = mountDraft({ initialDraft: '0xd7' });
    expect(document.activeElement).not.toBe(second.container.querySelector('input'));
  });
});

// ─── WAVE SEVEN, ELEMENT D: THE ROOM'S OWN READ ─────────────────────────────
//
// The directive's done-means, verbatim: "the scoped read with a fixture
// breakdown paints the room's row first and the whole-flame line second."
// So ORDER is asserted, not just presence — a block that printed both in the
// wrong order would satisfy every toBeInTheDocument and miss the whole point.

const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
// A Solana mint: base58, with real capitals. The registry and the island do not
// agree on case, which is the trap this element walks into if it compares raw.
const BAYLA_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function row(over: Record<string, unknown> = {}) {
  return {
    token_address: PEPE,
    chain: 'ethereum',
    name: 'Pepe',
    symbol: 'PEPE',
    heat_degrees: 338.21,
    first_seen_at_unix: AS_OF - 400 * 86_400,
    last_transfer_at_unix: AS_OF - 86_400,
    retired: false,
    ...over,
  };
}

function mountScoped(scope: { address: string; symbol: string }) {
  return render(
    <MemoryRouter>
      <HeatCard address={ADDR} variant="embedded" showEligibility={false} scopeTo={scope} />
    </MemoryRouter>,
  );
}

describe("element D — the room's own read", () => {
  it('paints the room’s row FIRST and the whole flame SECOND', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row()] }));
    const { container } = mountScoped({ address: PEPE, symbol: 'PEPE' });

    // Wait on the answer, not the question: the heading renders before the read lands.
    // Both strings live in ScopedReading, which mounts only once the read resolves.
    let text = '';
    let scoped = -1;
    let flame = -1;
    await waitFor(() => {
      text = container.textContent ?? '';
      scoped = text.indexOf('338.21');
      flame = text.indexOf('your whole flame reads');
      expect(scoped, 'the scoped number never rendered').toBeGreaterThan(-1);
      expect(flame, 'the whole-flame line never rendered').toBeGreaterThan(-1);
    });

    expect(scoped, 'the flame came first — the room asks its own question first').toBeLessThan(flame);
    expect(text).toContain('400 days held');
    expect(text).toContain(`${DEGREES.toFixed(2)}`);
  });

  it('reads a wallet with no row as holding none, and still names the flame', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row({ token_address: '0xother', symbol: 'OTHER' })] }));
    mountScoped({ address: PEPE, symbol: 'PEPE' });
    await waitFor(() =>
      expect(screen.getByText('This wallet holds no measured PEPE yet.')).toBeTruthy(),
    );
    // Never a bare "no" — a visitor with nothing HERE still has a flame, and
    // hiding it would read as a zero.
    expect(screen.getByText(/your whole flame reads/i)).toBeTruthy();
  });

  it('names the whole flame by its served tier, even where the bands would name another', async () => {
    // 95° sits in the Resident band; the island served Observer, so the flame line says Observer.
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 95, tier: 'Observer', breakdown: [row()] }));
    mountScoped({ address: PEPE, symbol: 'PEPE' });
    const line = await screen.findByText(/your whole flame reads/i);
    expect(line.textContent).toBe('your whole flame reads 95.00° Observer');
  });

  it('matches the contract case-insensitively, or every Solana room reads empty', async () => {
    // The registry holds this mint with capitals; the island echoes lowercase.
    // A raw === compare finds nothing and tells a holder they hold nothing.
    h.fetchHeat.mockResolvedValue(
      wireReading({ breakdown: [row({ token_address: BAYLA_MINT.toLowerCase(), symbol: 'BAYLA', heat_degrees: 92.5 })] }),
    );
    mountScoped({ address: BAYLA_MINT, symbol: 'BAYLA' });
    await waitFor(() => expect(screen.getByText('92.50')).toBeTruthy());
    expect(screen.queryByText('This wallet holds no measured BAYLA yet.')).toBeNull();
  });

  it('shows a retired row greyed, with the word and its own degrees', async () => {
    // Row R: greyed, with the word "retired". The row's degrees stay on screen:
    // a retired row that rendered as absent, or as a zero, would tell a holder
    // their time had been taken away, and the number is the island's to paint.
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row({ retired: true })] }));
    const { container } = mountScoped({ address: PEPE, symbol: 'PEPE' });
    await waitFor(() => expect(screen.getByText('338.21')).toBeTruthy());
    expect(screen.getByText('retired')).toBeTruthy();
    expect((screen.getByText('338.21') as HTMLElement).style.color).toBe('rgba(255, 255, 255, 0.45)');
    expect(container.textContent).not.toContain('This wallet holds no measured');
  });

  it('never renders the venue’s whole-flame ladder inside a room', async () => {
    // The room asks a narrower question. If the scope prop stopped taking
    // effect, the full instrument would render here and this would catch it.
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row()] }));
    const { container } = mountScoped({ address: PEPE, symbol: 'PEPE' });
    // Gate on the whole-flame degrees, painted in both renderings, so a scope regression
    // reaches the assertion below instead of timing out on a gate.
    await waitFor(() => expect(container.textContent ?? '').toContain(DEGREES.toFixed(2)));
    expect(container.textContent).not.toContain('Your rooms, deepest first');
  });
});

describe('element D — the room names its question before it has an answer', () => {
  it('shows the scoped heading COLD, before any read', async () => {
    // `variant="embedded"` drops the card's own title, which is right in the
    // gate and was wrong in a room: it left a visitor looking at an address
    // field and a Read button with nothing saying what they read. The question
    // must exist before the answer does.
    h.fetchHeat.mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <HeatCard variant="embedded" showEligibility={false} scopeTo={{ address: PEPE, symbol: 'PEPE' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Your held time in PEPE/i)).toBeTruthy();
  });

  it('names it exactly once when the answer arrives', async () => {
    // The heading moved out of the result block to sit above the form. If a
    // copy of it were left behind, a room would ask its question twice.
    h.fetchHeat.mockResolvedValue(wireReading({ breakdown: [row()] }));
    mountScoped({ address: PEPE, symbol: 'PEPE' });
    await waitFor(() => expect(screen.getByText('338.21')).toBeTruthy());
    expect(screen.getAllByText(/Your held time in PEPE/i)).toHaveLength(1);
  });
});

// ─── ROW R: A RETIRED ROW IS LABELED ────────────────────────────────────────
//
// Three rows, one retired: the retired row is greyed with the word, sorted last and left
// out of the token count. token_count is 3 because the island counts it in the envelope.

describe('row R: a retired row is labeled and not counted', () => {
  const OLD = row({ token_address: '0xold', symbol: 'OLD', name: 'Old', heat_degrees: 50, retired: true });
  const BBB = row({ token_address: '0xbbb', symbol: 'BBB', name: 'Bee', heat_degrees: 10 });
  const readingWith = (degrees: number) =>
    wireReading({ degrees, token_count: 3, breakdown: [OLD, row(), BBB] });
  const SYMBOLS = new Set(['PEPE', 'BBB', 'OLD']);

  it('renders the retired row greyed with the word, after the live rows, and the count without it', async () => {
    h.fetchHeat.mockResolvedValue(readingWith(398.21));
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('2 tokens counted')).toBeTruthy());

    const order = Array.from(container.querySelectorAll('li'))
      .map((li) => li.querySelector('span')?.textContent?.trim() ?? '')
      .filter((t) => SYMBOLS.has(t));
    expect(order).toEqual(['PEPE', 'BBB', 'OLD']);

    const retired = container.querySelectorAll('li[data-retired="true"]');
    expect(retired).toHaveLength(1);
    expect(retired[0].textContent).toContain('OLD');
    expect(retired[0].textContent).toContain('retired');
    expect(retired[0].textContent).toContain('50.00');
    expect(retired[0].querySelector('span')?.className).toContain('text-white/40');
  });

  it.each([398.21, 348.21, 500, 60])('prints no sum of the rows beside a served %s°', async (degrees) => {
    h.fetchHeat.mockResolvedValue(readingWith(degrees));
    mount();
    await waitFor(() => expect(screen.getByText('2 tokens counted')).toBeTruthy());
    expect(screen.getByText(degrees.toFixed(2))).toBeTruthy();
    expect(screen.queryByText(/Sum across/)).toBeNull();
    expect(screen.queryByText(/rows sum to/)).toBeNull();
    expect(screen.queryByText(/still includes the retired/)).toBeNull();
    expect(screen.queryByText('348.21°')).toBeNull();
  });
});

// The deepest room sets the heat and the rest amplify it, so the rooms never add up to
// the served number, and the card never adds them. The dEaD shape, 2026-09-23: 311.25°
// served Elder, its three deepest rooms 250.92, 233.75 and 212.06.
describe('the card prints the served heat and no sum of its rooms', () => {
  const DEAD = {
    degrees: 311.25,
    tier: 'Elder',
    token_count: 3,
    breakdown: [
      row({ heat_degrees: 250.92 }),
      row({ token_address: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', symbol: 'JBAC', name: 'Junglebayapeclub', heat_degrees: 233.75 }),
      row({ token_address: '0x420698cfdeddea6bc78d59bc17798113ad278f9d', symbol: 'TOWELI', name: 'TOWELI', heat_degrees: 212.06 }),
    ],
  };

  it('shows 311.25 and each room as served, with no sum line and no disagreement', async () => {
    h.fetchHeat.mockResolvedValue(wireReading(DEAD));
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('3 tokens counted')).toBeTruthy());
    expect(screen.getByText('311.25')).toBeTruthy();
    for (const d of ['250.92°', '233.75°', '212.06°']) expect(screen.getByText(d)).toBeTruthy();
    expect(screen.queryByText(/Sum across/)).toBeNull();
    expect(screen.queryByText(/rows sum to/)).toBeNull();
    expect(screen.queryByText(/still includes the retired/)).toBeNull();
    expect(container.textContent).not.toContain('696.73');
  });

  it('heads the rooms as rooms, deepest first, and never says the number comes from them', async () => {
    h.fetchHeat.mockResolvedValue(wireReading(DEAD));
    const { container } = mount();
    await waitFor(() => expect(screen.getByText('3 tokens counted')).toBeTruthy());
    const heading = screen.getByText('Your rooms, deepest first');
    const rows = [...heading.nextElementSibling!.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows.map((r) => r?.match(/[\d.]+°$/)?.[0])).toEqual(['250.92°', '233.75°', '212.06°']);
    expect(container.textContent).not.toMatch(/comes from/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ELEMENT B'S REMAINDER: THE FIVE-RUNG LADDER AND THE WALLET FILL.
// ─────────────────────────────────────────────────────────────────────────────

/** The card with NO pinned address, which is the only shape that has a form. */
function mountOpen() {
  return render(
    <MemoryRouter>
      <HeatCard variant="embedded" />
    </MemoryRouter>,
  );
}

/** The rungs as rendered, top of the list first. */
async function ladderRows(): Promise<string[]> {
  return waitFor(() => {
    const el = document.querySelector('[data-element="b-ladder"]');
    expect(el).not.toBeNull();
    return [...el!.querySelectorAll('li')].map((li) => li.textContent ?? '');
  });
}

describe('the ladder', () => {
  // Unstubbed here and not inside the test body: a stub set before an awaited
  // assertion that throws would otherwise leak its floor into every later test.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 95 degrees: Drifter, Observer and Resident reached, Builder next at 300.
  const MID = { degrees: 95, tier: 'Resident' as const };

  it('climbs all five rungs, lowest first', async () => {
    h.fetchHeat.mockResolvedValue(wireReading(MID));
    mount();
    const rungs = await ladderRows();
    expect(rungs).toHaveLength(5);
    // THE ISLAND'S DIALS, CLIMBED. TIER_FLOORS is published high-to-low and a
    // ladder is read low-to-high, so a list rendered in source order is a real
    // defect and not a style choice. Five rungs, Drifter included: a warm wallet
    // under 30 is standing on it, and a ladder that hides the rung under
    // somebody's feet has started lying about where they are.
    expect(rungs[0]).toContain('Drifter');
    expect(rungs[0]).toContain('0°');
    expect(rungs[1]).toContain('Observer');
    expect(rungs[1]).toContain('30°');
    expect(rungs[2]).toContain('Resident');
    expect(rungs[2]).toMatch(/(^|[^0-9])80°/);
    expect(rungs[3]).toContain('Builder');
    expect(rungs[3]).toMatch(/(^|[^0-9])300°/);
    expect(rungs[4]).toContain('Elder');
    expect(rungs[4]).toMatch(/(^|[^0-9])800°/);
  });

  it('lights the rungs this wallet has reached, and only those', async () => {
    h.fetchHeat.mockResolvedValue(wireReading(MID));
    mount();
    const rungs = await ladderRows();
    const reached = rungs.filter((r) => r.includes('reached'));
    expect(reached).toHaveLength(3);
    expect(reached.every((r) => /Drifter|Observer|Resident/.test(r))).toBe(true);
    expect(rungs[3]).not.toContain('reached');
    expect(rungs[4]).not.toContain('reached');
  });

  it('prints the gap to the next rung as arithmetic on two served numbers', async () => {
    h.fetchHeat.mockResolvedValue(wireReading(MID));
    mount();
    // 300 (the rung's floor) minus 95 (the degrees the island served). Not a
    // rate, not a date, and nothing the instrument computed for itself.
    expect(await screen.findByText('205.00° to Builder')).toBeTruthy();
  });

  // TIER_FLOORS answers "what tier is this number" and heatLaunchFloor() "what number
  // opens the launch door", so the word beside the floor is derived from both, never
  // typed. The assertions sit on the sentence <p> and the eligibility span, not the rung
  // <li>: each rung prints its own label, so "Resident" sits beside a 123 sentence.
  it('names no tier beside a floor that sits between rungs (123)', async () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '123');
    h.fetchHeat.mockResolvedValue(wireReading(MID));
    mount();
    const sentence = await screen.findByText('The launch door opens at 123 degrees.');
    expect(sentence.textContent).not.toMatch(/Elder|Builder|Resident|Observer|Drifter/);
    // Hung under the rung tierFor returns, which for 123 is Resident.
    expect(sentence.closest('li')?.textContent).toMatch(/^Resident\s*80°/);
    expect(screen.getByText('the door opens at 123°')).toBeTruthy();
    expect(screen.queryByText(/you reach/)).toBeNull();
  });

  it('names the tier a floor sits exactly on, under that rung (300)', async () => {
    vi.stubEnv('VITE_HEAT_LAUNCH_FLOOR', '300');
    h.fetchHeat.mockResolvedValue(wireReading(MID));
    mount();
    const sentence = await screen.findByText(
      'At 300 degrees you reach Builder, the tier that may plant a launch here.',
    );
    expect(sentence.closest('li')?.textContent).toMatch(/^Builder\s*300°/);
    expect(screen.getByText('the door opens at 300° · Builder')).toBeTruthy();
    expect(screen.queryByText(/reach Resident|· Resident/)).toBeNull();
  });

  it('shows no ladder at all on a cold read', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ is_cold: true, degrees: 0, tier: 'Drifter', token_count: 0 }));
    mount();
    await screen.findByText(/Nothing measured here yet/);
    expect(document.querySelector('[data-element="b-ladder"]')).toBeNull();
  });
});

describe('the wallet fill', () => {
  const INJECTED = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).ethereum;
    delete (window as unknown as Record<string, unknown>).solana;
  });

  function field() {
    return screen.getByLabelText(/Wallet address to read Heat for/) as HTMLInputElement;
  }

  it('offers nothing when the browser has no wallet to offer', () => {
    mountOpen();
    expect(screen.queryByRole('button', { name: 'Use my wallet' })).toBeNull();
  });

  it('fills from the account the page is ALREADY allowed to see, with no prompt', async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_accounts' ? [INJECTED] : [],
    );
    (window as unknown as Record<string, unknown>).ethereum = { request };
    mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Use my wallet' }));
    await waitFor(() => expect(field().value).toBe(INJECTED));
    // The silent read answered, so nobody was asked anything.
    expect(request.mock.calls.map((c) => (c[0] as { method: string }).method)).toEqual(['eth_accounts']);
  });

  it('asks for accounts only after the tap, and never for a signature', async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? [INJECTED] : [],
    );
    (window as unknown as Record<string, unknown>).ethereum = { request };
    mountOpen();
    // Nothing is asked on mount: the button exists and the wallet is untouched.
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use my wallet' }));
    await waitFor(() => expect(field().value).toBe(INJECTED));
    const methods = request.mock.calls.map((c) => (c[0] as { method: string }).method);
    expect(methods).toEqual(['eth_accounts', 'eth_requestAccounts']);
    expect(methods.some((m) => /sign/i.test(m))).toBe(false);
  });

  it('takes a Solana public key the wallet already trusts us with', async () => {
    (window as unknown as Record<string, unknown>).solana = {
      publicKey: 'BaYLaSo1anaMintAddress11111111111111111111',
    };
    mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Use my wallet' }));
    await waitFor(() => expect(field().value).toBe('BaYLaSo1anaMintAddress11111111111111111111'));
  });

  it('says one sentence when nothing answers, and keeps the field', async () => {
    (window as unknown as Record<string, unknown>).ethereum = {
      request: vi.fn(async () => {
        throw new Error('User rejected the request.');
      }),
    };
    mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Use my wallet' }));
    expect(await screen.findByText('Paste the address instead.')).toBeTruthy();
    // No error code, no reason, no retry - and the field is still there to paste into.
    expect(screen.queryByText(/User rejected/)).toBeNull();
    expect(field()).toBeTruthy();
  });
});

describe('the field names every chain the reader takes', () => {
  it('asks for an Ethereum, Base, or Solana address, in its label and its hint', () => {
    h.supported = false;
    mountOpen();
    expect(screen.getByLabelText('Wallet address to read Heat for (Ethereum, Base, or Solana)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read Heat' }).getAttribute('title')).toBe(
      'Enter an Ethereum, Base, or Solana address',
    );
  });
});

describe('a reading older than the freshness law allows', () => {
  it('says it is stale without a prose em dash', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ as_of_unix: NOW - 8 * 86_400, observedAt: NOW - 8 * 86_400 }));
    mount();
    const line = await screen.findByText(/^Stale/);
    expect(line.textContent).toBe('Stale: older than 7 days, so it decides nothing');
  });
});

describe('the island dials, on the card', () => {
  it('lights every rung for the island’s lowest served Elder (890.93, 2026-09-29) and hangs the launch sentence under Resident', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 890.93, tier: 'Elder' }));
    mount();
    const rungs = await ladderRows();
    expect(rungs.map((r) => r.match(/^([A-Za-z]+)\s*(\d+)°/)?.slice(1))).toEqual([
      ['Drifter', '0'], ['Observer', '30'], ['Resident', '80'], ['Builder', '300'], ['Elder', '800'],
    ]);
    expect(rungs.every((r) => r.includes('reached'))).toBe(true);
    expect(screen.queryByText(/° to /)).toBeNull();
    expect(rungs[2]).toContain('At 80 degrees you reach Resident, the tier that may plant a launch here.');
    expect(screen.getByText('the door opens at 80° · Resident')).toBeTruthy();
  });

  it('reads an Observer at 73.89 with Resident unreached and the door at 80', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 73.89, tier: 'Observer' }));
    mount();
    const rungs = await ladderRows();
    expect(rungs[2]).toMatch(/^Resident\s*80°/);
    expect(rungs[2]).not.toContain('reached');
    expect(screen.getByText('6.11° to Resident')).toBeTruthy();
    expect(screen.getByText('the door opens at 80° · Resident')).toBeTruthy();
    expect(screen.getByText('Cannot launch a token yet')).toBeTruthy();
  });

  it('names the wallet by its served tier, while the rungs come from the bands', async () => {
    // Served 'Observer' at 95.00: the headline says what the island said, and the
    // Resident rung (80) is still lit, because rungs place a number and never name a wallet.
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 95, tier: 'Observer' }));
    mount();
    const headline = await awaitRead('Observer');
    expect(headline.closest('[data-element="b-ladder"]'), 'the first Observer is a rung, not the headline').toBeNull();
    const offLadder = screen.queryAllByText('Resident').filter((el) => !el.closest('[data-element="b-ladder"]'));
    expect(offLadder, 'the bands named the wallet').toEqual([]);
    const rungs = await ladderRows();
    expect(rungs[2]).toMatch(/^Resident\s*80°/);
    expect(rungs[2]).toContain('reached');
    expect(rungs[3]).not.toContain('reached');
  });

  // Real flames on the island's board, 2026-09-30. On the retired 150 / 250 floors the
  // card lit Builder and Elder beneath a headline that said Resident, and lit Elder
  // beneath a Builder with no rung left to climb.
  it('reads a Resident at 285.34 with Builder next and unlit, as the island served it', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 285.34, tier: 'Resident' }));
    mount();
    const rungs = await ladderRows();
    expect(rungs[2]).toContain('reached');
    expect(rungs[3]).toMatch(/^Builder\s*300°/);
    expect(rungs[3]).not.toContain('reached');
    expect(rungs[3]).toContain('14.66° to Builder');
    expect(rungs[4]).not.toContain('reached');
  });

  it('reads a Builder at 671.89 with Builder lit and Elder next, as the island served it', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 671.89, tier: 'Builder' }));
    mount();
    const rungs = await ladderRows();
    expect(rungs[3]).toContain('reached');
    expect(rungs[4]).toMatch(/^Elder\s*800°/);
    expect(rungs[4]).not.toContain('reached');
    expect(rungs[4]).toContain('128.11° to Elder');
  });

  it('tells a 200° wallet it is 100.00° from Builder, never 50.00° from Elder', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 200, tier: 'Resident' }));
    mount();
    expect(await screen.findByText('100.00° to Builder')).toBeTruthy();
    expect(screen.queryByText(/° to Elder/)).toBeNull();
  });
});

describe('the maths fold carries the island paragraph, never a formula', () => {
  const PARAGRAPH =
    'Heat counts your warm days: every day you hold, weighted by size and by the coin. Your deepest room sets your heat; every other room adds a quarter of its own, so breadth amplifies depth and never replaces it. Degrees are the temperature of that count: one real position held half a year reads 80°, Resident. Past Resident the number reads like fire: every degree costs a little more than the last, and the hottest flames stay in range. Size can raise what a day is worth, it cannot buy a day, and price never enters it. The rate is one curve for every wallet: nothing under 0.0001% of a supply, a full day at 0.01%, two at 1%, and never more. From a real position up, ten times the bag adds half a day. The tier words bind your island heat. Trading speed cannot move it.';

  async function openMaths() {
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'How heat is earned' }));
    return view;
  }

  it('is opened by "How heat is earned" and closed by "Hide"', async () => {
    mount();
    const closed = await screen.findByRole('button', { name: 'How heat is earned' });
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(closed);
    const open = await screen.findByRole('button', { name: 'Hide' });
    expect(open.textContent).toBe('Hide');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: /calculat|maths|how heat is earned/i })).toBeNull();
    fireEvent.click(open);
    expect((await screen.findByRole('button', { name: 'How heat is earned' })).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on the paragraph, word for word, then Days, Size and Weight', async () => {
    await openMaths();
    expect(screen.getByText(PARAGRAPH).tagName).toBe('P');
    const fold = screen.getByText(PARAGRAPH).parentElement!;
    const items = [...fold.querySelectorAll('ul')[0]!.querySelectorAll(':scope > li')];
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual(['Days', 'Size', 'Weight']);
    expect(items[0]!.textContent).toBe('Days Your clock on a token starts at your first hold.');
    expect(items[1]!.textContent).toBe('Size A real position earns a full day. The largest holders earn up to two. Dust earns nothing. An Ape counts by the piece: one is a full day, ten are two.');
    // The island's weight line on /heat, word for word after the fold's own lead-in.
    expect(items[2]!.textContent?.replace(/\s+/g, ' ')).toBe(
      "Weight is the island's published multiplier. The island's own weigh heavier: the Apes, JBM and BAYLA carry the island's edge, the home team leans warm. An Ape counts by the piece.",
    );
  });

  it('prints no formula line, no TWAB, no averaging and no sum', async () => {
    const { container } = await openMaths();
    const text = container.textContent ?? '';
    expect(text).toContain(PARAGRAPH);
    expect(text).not.toMatch(
      /heat\s*=|degrees\s*=|weight\s*×|√|∝|÷|TWAB|time[\s\u00ad\u2010-\u2015-]*weighted|average is taken|whole held time|the formula|added together|read per token|balance at every|balance held across|not a snapshot/i,
    );
    expect(text).toMatch(/The instrument is continuous, zero-anchored/);
  });

  it('lists the tiers on your heat as the island ladder does: a name and a floor', async () => {
    await openMaths();
    const heading = screen.getByText('The tiers, on your heat');
    expect(screen.queryByText(/on your total/)).toBeNull();
    const list = heading.parentElement!.querySelector('ul')!;
    const rows = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['Elder800°✓ reached', 'Builder300°✓ reached', 'Resident80°✓ reached', 'Observer30°✓ reached']);
  });

  // The default reading (1785.14) reaches every tier on either set of bands, so on its own
  // it cannot catch a wrong band. 285.34 is a Resident the island served on 2026-09-30.
  it('marks only the tiers this heat has reached (285.34: Resident and Observer)', async () => {
    h.fetchHeat.mockResolvedValue(wireReading({ degrees: 285.34, tier: 'Resident' }));
    await openMaths();
    const list = screen.getByText('The tiers, on your heat').parentElement!.querySelector('ul')!;
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Elder800°', 'Builder300°', 'Resident80°✓ reached', 'Observer30°✓ reached',
    ]);
  });
});

describe('the panel opens on the island sentences', () => {
  it('says what heat is in the island paragraph first two sentences, with no dash', async () => {
    const { container } = render(
      <MemoryRouter>
        <HeatCard address={ADDR} />
      </MemoryRouter>,
    );
    await awaitRead();
    const intro = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('not a venue score'));
    expect(intro?.textContent).toBe(
      `${VENUE.heatPlain} It is not a venue score and it pays nothing: it is the island's own ` +
        'instrument, read live. Price never enters it, a fresh bag starts near zero however big it is, ' +
        'and trading in and out earns nothing.',
    );
  });
});
