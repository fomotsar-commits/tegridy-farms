import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// /solana-lp: the same live venue read as /pools decides whether the LP section mounts.
// The section is stubbed here (it shows the order it was asked for);
// SolanaLpPage.mintLink.test.tsx mounts the real one.
const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../components/solana/lp/SolanaLpSection', () => ({
  default: ({ finderFirst = false }: { finderFirst?: boolean }) => <div data-testid="lp-section" data-finder-first={String(finderFirst)} />,
}));
const lp = vi.hoisted(() => ({ mode: 'on' as 'off' | 'on' | 'withdraw-only' }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => lp.mode,
}));

const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
// A real mint (32 bytes of base58), for the ?mint= the cross-link carries.
const M = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const LIVE = {
  kind: 'live',
  programId: PROGRAM,
  config: {
    address: 'CfG1111111111111111111111111111111111111111',
    index: 0, disableCreatePool: false,
    tradeFeeRate: 2500n, protocolFeeRate: 120_000n, fundFeeRate: 0n,
    createPoolFee: 0n, creatorFeeRate: 0n,
    protocolOwner: 'Own1', fundOwner: 'Own2',
  },
} as const;
const UNREADABLE = { kind: 'unreadable', detail: 'proxy timed out' } as const;

// The page's module graph is loaded once, outside any test's own clock. No test needs a
// fresh copy: the reads and LP's mode are looked up on every render.
beforeAll(async () => { await import('./SolanaLpPage'); }, 60_000);

// jsdom has no scrollIntoView. The page calls it on the status card, so this is the record.
const scrolled = vi.fn();
const proto = Element.prototype as { scrollIntoView?: unknown };
beforeAll(() => { proto.scrollIntoView = scrolled; });
afterAll(() => { delete proto.scrollIntoView; });

async function mount(path = '/solana-lp') {
  const { default: SolanaLpPage } = await import('./SolanaLpPage');
  return render(<MemoryRouter initialEntries={[path]}><SolanaLpPage /></MemoryRouter>);
}

const settled = () => waitFor(() => expect(screen.queryByText(/Reading the venue/i)).not.toBeInTheDocument());

/** No LP section, and none on its way: the section is lazy, so its loading line counts too. */
function expectNoLpSection() {
  expect(screen.queryByTestId('lp-section')).toBeNull();
  expect(screen.queryByText(/Loading the pool finder/)).toBeNull();
}

const venueAmmLink = () => screen.getByRole('link', { name: /fees, status and how the pools work/i });

/** The hero block, and each thing after it in the page's column, top to bottom. */
function column() {
  const hero = screen.getByRole('heading', { level: 1 }).parentElement!;
  const after: Element[] = [];
  for (let el = hero.nextElementSibling; el; el = el.nextElementSibling) after.push(el);
  return { hero, after };
}

beforeEach(() => { vi.clearAllMocks(); lp.mode = 'on'; });

describe('when the venue reads live', () => {
  beforeEach(() => { readVenue.mockResolvedValue(LIVE); });

  // The tab opens on the finder: nothing sits between the hero and the LP section.
  it('mounts the LP section finder-first right under the hero, then the status card, then "The program"', async () => {
    await mount();
    const section = await screen.findByTestId('lp-section');
    expect(section).toHaveAttribute('data-finder-first', 'true');
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(card).toHaveTextContent(/Pools are open/);
    const { hero, after } = column();
    expect(hero).toHaveTextContent(/Create a pool, add liquidity or take it out/);
    expect(after).toHaveLength(3);
    expect(after[0]!.firstElementChild).toBe(section);
    expect(after[1]).toBe(card);
    expect(after[2]).toBe(screen.getByRole('region', { name: 'The program' }));
  });

  // In the hero the link cost a 390px phone 63px of first screen above the finder's field.
  it('the Venue AMM link follows the section, and the hero ends on its own words', async () => {
    await mount(`/solana-lp?mint=${M}&amount=5`);
    const section = await screen.findByTestId('lp-section');
    const { hero, after } = column();
    expect(within(hero).queryByRole('link')).toBeNull();
    expect(hero.lastElementChild).toHaveTextContent(/^Create a pool, add liquidity or take it out/);
    const link = venueAmmLink();
    expect(link).toHaveAttribute('href', `/pools?mint=${M}`);
    expect(after[0]).toContainElement(link);
    expect(section.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  // The live card sits under the section here, so it may not point down at it.
  it('the live card says the pools section is above it, never below', async () => {
    await mount();
    await screen.findByTestId('lp-section');
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(card).toHaveTextContent('(the pools section above says whether it can right now)');
    expect(card).not.toHaveTextContent(/below/);
  });

  it('heads the page Solana liquidity and says what can be done here, by LP mode', async () => {
    await mount();
    await screen.findByTestId('lp-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Solana liquidity.');
    expect(document.title).toMatch(/^Solana liquidity/);
    // The venue read alone does not say each can be done right now: the section's own reads do.
    expect(
      screen.getByText(/^Create a pool, add liquidity or take it out on the venue.s own Solana AMM\.$/),
    ).toBeInTheDocument();
  });

  it("'withdraw-only' and 'off' never say adding is open", async () => {
    lp.mode = 'withdraw-only';
    const first = await mount();
    await screen.findByTestId('lp-section');
    expect(screen.getByText(/take your liquidity out.*Adding liquidity and opening pools from here are paused\./)).toBeInTheDocument();
    expect(screen.queryByText(/add or remove liquidity, or open/)).toBeNull();
    first.unmount();
    lp.mode = 'off';
    await mount();
    await screen.findByTestId('lp-section');
    expect(screen.getByText(/Adding and removing liquidity from here is not switched on yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/add or remove liquidity, or open/)).toBeNull();
  });

  it('the page description is the same in every LP mode and claims no adding, removing or opening', async () => {
    const seen = new Set<string>();
    for (const mode of ['on', 'withdraw-only', 'off'] as const) {
      lp.mode = mode;
      const view = await mount();
      await screen.findByTestId('lp-section');
      const text = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
      expect(text).toMatch(/Solana AMM/);
      expect(text).not.toMatch(/\b(add|adding|remove|removing|open|opening|take|taking)\b/i);
      expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(text);
      seen.add(text);
      view.unmount();
    }
    expect(seen.size).toBe(1);
  });

  it('the live card does not point at a fee sheet this tab does not have', async () => {
    await mount();
    await screen.findByTestId('lp-section');
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(card).toHaveTextContent(/Pools are open/);
    expect(card).not.toHaveTextContent(/Fees below/);
  });

  it('Refresh keeps the LP section mounted while it reads again', async () => {
    readVenue.mockResolvedValueOnce(LIVE).mockReturnValueOnce(new Promise(() => {}));
    await mount();
    await screen.findByTestId('lp-section');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('lp-section')).toBeInTheDocument();
    expect(screen.queryByText(/Reading the venue/i)).toBeNull();
  });

  // One card, live or not: a failed re-read changes what it says, not which button was pressed.
  it('a Refresh whose re-read fails keeps keyboard focus on that same Refresh', async () => {
    readVenue.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(UNREADABLE);
    await mount();
    await screen.findByTestId('lp-section');
    const pressed = screen.getByRole('button', { name: 'Refresh' });
    pressed.focus();
    expect(document.activeElement).toBe(pressed);
    fireEvent.click(pressed);
    await screen.findByText(/The chain could not be read/i);
    const card = screen.getByRole('region', { name: 'Venue status' });
    expectNoLpSection();
    expect(document.activeElement).toBe(pressed);
    expect(within(card).getByRole('button', { name: 'Refresh' })).toBe(pressed);
    expect(column().after[0]).toBe(card);
  });

  // The section above the card goes away, so the card jumps up the page under the reader.
  it('a Refresh whose re-read fails brings the card back into view; one that reads live does not scroll', async () => {
    let answer!: (v: unknown) => void;
    readVenue.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(LIVE).mockReturnValueOnce(new Promise((r) => { answer = r; }));
    await mount();
    await screen.findByTestId('lp-section');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readVenue).toHaveBeenCalledTimes(3));
    expect(scrolled).not.toHaveBeenCalled();
    answer(UNREADABLE);
    await screen.findByText(/The chain could not be read/i);
    expect(scrolled).toHaveBeenCalledTimes(1);
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(scrolled.mock.contexts[0]).toBe(card);
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
    // The scroll stops short of the fixed header and tab strip (e2e measures it in a browser).
    expect(card).toHaveClass('scroll-mt-24');
  });
});

describe('when the venue does not read live', () => {
  it.each([
    [{ kind: 'no-program-id' }, /has no program id to read/i],
    [{ kind: 'no-config', programId: PROGRAM }, /one instruction from open/i],
    [{ kind: 'program', deployment: { kind: 'closed' } }, /That program id is closed/i],
    [UNREADABLE, /The chain could not be read/i],
  ])('%o: the status card says so, and no LP section', async (status, title) => {
    readVenue.mockResolvedValue(status);
    await mount();
    await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
    expectNoLpSection();
    // No present-tense claim above a card that says the venue is not open.
    expect(screen.queryByText(/^Find a pool/)).toBeNull();
    expect(screen.getByText(/once a chain read says the venue is open/i)).toBeInTheDocument();
    // The card is directly under the hero, which says "the card below"; then "The program".
    const { hero, after } = column();
    expect(hero).toHaveTextContent(/The card below says what the latest read found\./);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(screen.getByRole('region', { name: 'Venue status' }));
    expect(after[0]).toHaveTextContent(title);
    expect(after[1]).toBe(screen.getByRole('region', { name: 'The program' }));
    // The Venue AMM link is the hero's last line, as it was before the finder came first.
    expect(hero.lastElementChild).toContainElement(venueAmmLink());
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('while the first read is in flight: reading, and no LP section', async () => {
    readVenue.mockReturnValue(new Promise(() => {}));
    await mount();
    await waitFor(() => expect(screen.getByText(/Reading the venue/i)).toBeInTheDocument());
    expectNoLpSection();
    const { after } = column();
    expect(after).toHaveLength(2);
    expect(after[0]).toHaveTextContent(/Reading the venue/i);
    expect(after[1]).toBe(screen.getByRole('region', { name: 'The program' }));
  });

  it('Refresh reads again, and the section mounts once the venue reads live', async () => {
    readVenue.mockResolvedValueOnce(UNREADABLE).mockResolvedValueOnce(LIVE);
    await mount();
    await settled();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('lp-section')).toBeInTheDocument();
    expect(readVenue).toHaveBeenCalledTimes(2);
    // The finder arriving above the card moves nothing under the reader's thumb.
    expect(scrolled).not.toHaveBeenCalled();
  });

  // The card is all this tab shows then, so a second failure has to look like a new read.
  it('Refresh on a failed read goes back to reading, then shows the second failure', async () => {
    let answer!: (v: unknown) => void;
    readVenue.mockResolvedValueOnce(UNREADABLE).mockReturnValueOnce(new Promise((r) => { answer = r; }));
    await mount();
    await screen.findByText(/The chain could not be read/i);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Reading the venue/i)).toBeInTheDocument();
    expect(screen.queryByText(/The chain could not be read/i)).toBeNull();
    answer(UNREADABLE);
    expect(await screen.findByText(/The chain could not be read/i)).toBeInTheDocument();
    expect(readVenue).toHaveBeenCalledTimes(2);
    expectNoLpSection();
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('always', () => {
  beforeEach(() => { readVenue.mockResolvedValue(UNREADABLE); });

  it('links to the Venue AMM tab for fees, status and how the pools work', async () => {
    await mount();
    await settled();
    expect(venueAmmLink()).toHaveAttribute('href', '/pools');
  });

  it('the link carries the token being looked at, and nothing else from the URL', async () => {
    const first = await mount(`/solana-lp?mint=${M}&amount=5`);
    await settled();
    expect(venueAmmLink()).toHaveAttribute('href', `/pools?mint=${M}`);
    first.unmount();
    await mount('/solana-lp?mint=not%20a%20mint%3Cb%3E&amount=5');
    await settled();
    expect(venueAmmLink()).toHaveAttribute('href', '/pools');
  });

  // The LP section's disclosure says: see "The program" below. So it is below, here too.
  it('shows "The program" at the foot of the page', async () => {
    await mount();
    await settled();
    const program = screen.getByRole('region', { name: 'The program' });
    expect(program).toHaveTextContent(/one added instruction/i);
    const card = screen.getByRole('region', { name: 'Venue status' });
    expect(card.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
