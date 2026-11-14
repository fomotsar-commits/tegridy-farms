// Island answer twenty-five, screen 3, build 6: the receipt card after a swap or an add lands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReceiptCard } from './ReceiptCard';
import { clearReceipt, clockFor, holdersFor, raiseReceipt, settleReceipt, type Receipt } from '../lib/receipt';
import { clearScreenMoves, useCurrentScreenMove } from '../lib/screenMove';
import { clearLanded, lastLanded } from '../lib/landed';
import type { HeatReading } from '../lib/heat/heatOracle';
import { startShoreMoment } from '../lib/shoreMoment';

const confetti = vi.hoisted(() => ({ fire: vi.fn() }));
// The venue's confetti, as the provider gives it. The card never calls it (island answer
// twenty-nine: the flame catches in the ring instead); the farm keeps its own.
vi.mock('../hooks/useConfetti', () => ({ useConfetti: () => ({ fire: () => confetti.fire() }) }));
// The shore's engine draws on canvases jsdom does not have (FlameCatch.test.tsx proves the wiring).
vi.mock('../lib/shoreMoment', () => ({ startShoreMoment: vi.fn(() => () => {}) }));

const SIG = '5Kq3' + 'x'.repeat(80) + '9xWz';
const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
// A buy in a room posts the shore's line and the room with its Buy open (island answer thirty-six).
const BUY_INTENT = `https://x.com/intent/post?text=${encodeURIComponent("Just bought $BAYLA. I'm on the shore now. Every light here holds it. https://memetics.finance/bayla?sheet=buy")}`;

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    signature: SIG,
    explorerUrl: `https://solscan.io/tx/${SIG}`,
    wallet: WALLET,
    action: 'bought',
    coin: { symbol: 'BAYLA', mint: BAYLA },
    island: true,
    title: null,
    under: null,
    fee: { kind: 'reading' },
    clock: 'day1',
    holders: null,
    lps: null,
    ...over,
  };
}

function Move() {
  return <p data-testid="move">{useCurrentScreenMove() ?? 'none'}</p>;
}

// A buy or an add in a room fetches its GIF (island answer thirty-six): none, unless a test hands one.
const fetchClip = vi.fn(async (_url: string) => new Response('none', { status: 404 }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchClip.mockClear();
  fetchClip.mockImplementation(async () => new Response('none', { status: 404 }));
  vi.stubGlobal('fetch', fetchClip);
  clearReceipt();
  clearScreenMoves();
  clearLanded();
  confetti.fire.mockClear();
  render(
    <>
      <ReceiptCard />
      <Move />
    </>,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the receipt card', () => {
  it('is nothing until something lands', () => {
    expect(screen.queryByTestId('receipt-card')).toBeNull();
    expect(screen.getByTestId('move')).toHaveTextContent('none');
  });

  it('rises with no confetti, says it is reading the fee, and holds one green button: Share on X, the shore’s GIF and the post', async () => {
    act(() => raiseReceipt(receipt()));
    expect(confetti.fire).not.toHaveBeenCalled();
    // Bayla's line says Done, and her Receipt goes quiet while the card is up.
    expect(lastLanded()?.kind).toBe('trade');
    expect(screen.getByTestId('move')).toHaveTextContent('receipt');
    const card = screen.getByRole('dialog', { name: 'Bought BAYLA' });
    expect(within(card).getByRole('status')).toHaveTextContent('Reading the fee from the transaction…');
    const sig = within(card).getByRole('link', { name: /on the explorer/ });
    expect(sig).toHaveAttribute('href', `https://solscan.io/tx/${SIG}`);
    expect(sig).toHaveTextContent('5Kq3 … 9xWz');
    const share = within(card).getByRole('link', { name: 'Share on X' });
    expect(share).toHaveAttribute('href', BUY_INTENT);
    expect(share).toHaveAttribute('target', '_blank');
    expect(card.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(share).toHaveClass('btn-primary');
    expect(within(card).getByRole('button', { name: 'Back to the room' })).toBeInTheDocument();
    expect(within(card).getByTestId('receipt-clock')).toHaveTextContent('Day 1 of your clock on BAYLA starts tonight.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(card.style.opacity).toBe('1');
    expect(confetti.fire).not.toHaveBeenCalled();
  });

  it('the card’s words, rows, Share and Back are exactly what they were: the ring says nothing', () => {
    act(() => raiseReceipt(receipt()));
    act(() => settleReceipt(SIG, { title: 'Bought 25,623 BAYLA', under: 'for 0.122 SOL, on the venue', fee: { kind: 'pool', unit: 'SOL', fee: '0.00122 SOL', lps: '0.001025 SOL', venue: '0.000195 SOL', creator: null } }));
    const card = screen.getByTestId('receipt-card');
    // The card's text, element by element, with nothing between them.
    expect(card.textContent).toBe(
      [
        'Bought 25,623 BAYLA',
        'for 0.122 SOL, on the venue',
        'Fee0.00122 SOL',
        "To this pool's LPs0.001025 SOL",
        'To the venue and the island0.000195 SOL',
        'Signature5Kq3 … 9xWz ↗',
        'Day 1 of your clock on BAYLA starts tonight.',
        'Share on X',
        'Back to the room',
      ].join(''),
    );
    expect(card.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('the landing adds one line under the title (island answer thirty), and nothing else on the card moves', async () => {
    act(() => raiseReceipt(receipt()));
    act(() => settleReceipt(SIG, { title: 'Bought 25,623 BAYLA', under: 'for 0.122 SOL, on the venue', fee: { kind: 'pool', unit: 'SOL', fee: '0.00122 SOL', lps: '0.001025 SOL', venue: '0.000195 SOL', creator: null } }));
    // The rise, then the card up: one move of the clock each, so the card arms the second on a re-render.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const onLanded = vi.mocked(startShoreMoment).mock.lastCall?.[0].onLanded;
    expect(onLanded).toBeTypeOf('function');
    act(() => onLanded?.());
    expect(screen.getByTestId('receipt-card').textContent).toBe(
      [
        'Bought 25,623 BAYLA',
        'for 0.122 SOL, on the venue',
        "You're on $BAYLA's shore. Every light here holds it.",
        'Fee0.00122 SOL',
        "To this pool's LPs0.001025 SOL",
        'To the venue and the island0.000195 SOL',
        'Signature5Kq3 … 9xWz ↗',
        'Day 1 of your clock on BAYLA starts tonight.',
        'Share on X',
        'Back to the room',
      ].join(''),
    );
  });

  it('a swap in our pool: what was done, the fee, the LPs’ part and the venue and island’s part, as read', () => {
    act(() => raiseReceipt(receipt()));
    act(() =>
      settleReceipt(SIG, {
        title: 'Bought 13,371 BAYLA',
        under: 'for 0.1 SOL, on the venue',
        fee: { kind: 'pool', unit: 'SOL', fee: '0.001 SOL', lps: '0.00084 SOL', venue: '0.00016 SOL', creator: null },
      }),
    );
    const card = screen.getByRole('dialog', { name: 'Bought 13,371 BAYLA' });
    expect(within(card).getByTestId('receipt-under')).toHaveTextContent('for 0.1 SOL, on the venue');
    const rows = within(card).getByTestId('receipt-rows');
    expect(rows).toHaveTextContent('Fee0.001 SOL');
    expect(rows).toHaveTextContent("To this pool's LPs0.00084 SOL");
    expect(rows).toHaveTextContent('To the venue and the island0.00016 SOL');
    expect(rows).not.toHaveTextContent("pool's creator");
  });

  it('Jupiter’s route says what the venue’s fee account received, or that this route took nothing', () => {
    act(() => raiseReceipt(receipt({ fee: { kind: 'site', venue: '0.001 SOL' } })));
    expect(screen.getByTestId('receipt-rows')).toHaveTextContent('To the venue and the island0.001 SOL');
    expect(screen.getByTestId('receipt-rows')).not.toHaveTextContent("To this pool's LPs");
    act(() => settleReceipt(SIG, { fee: { kind: 'site', venue: null } }));
    expect(screen.getByTestId('receipt-rows')).toHaveTextContent('To the venue and the islandnothing on this route');
  });

  it('an add of both coins pays the pool no fee: the network’s cost instead; its clock counts double', () => {
    act(() => raiseReceipt(receipt({ action: 'added', pairing: 'SOL', clock: 'double', under: 'to the SOL + BAYLA pool', fee: { kind: 'add', network: '0.000005 SOL' } })));
    expect(lastLanded()?.kind).toBe('add');
    const card = screen.getByRole('dialog', { name: 'Added SOL + BAYLA' });
    expect(within(card).getByTestId('receipt-rows')).toHaveTextContent('No venue fee on an add0.000005 SOL');
    expect(within(card).getByTestId('receipt-clock')).toHaveTextContent('Every day in this pool counts double from tomorrow.');
  });

  it('a fee the transaction did not show is said as not read, never a figure', () => {
    act(() => raiseReceipt(receipt({ fee: { kind: 'unread' } })));
    expect(screen.getByTestId('receipt-rows')).toHaveTextContent('Feecould not be read from the transaction');
  });

  it('a card whose fee is read at once still rises: the read’s re-render never cancels the rise', async () => {
    act(() => raiseReceipt(receipt()));
    act(() => settleReceipt(SIG, { title: 'Bought 25,623 BAYLA', fee: { kind: 'pool', unit: 'SOL', fee: '0.00122 SOL', lps: '0.0010248 SOL', venue: '0.0001952 SOL', creator: null } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByTestId('receipt-card').style.opacity).toBe('1');
  });

  it('a late read of an older signature never touches a newer card', () => {
    act(() => raiseReceipt(receipt({ signature: 'old' })));
    act(() => raiseReceipt(receipt()));
    act(() => settleReceipt('old', { title: 'Bought 1 BAYLA' }));
    expect(screen.getByRole('dialog', { name: 'Bought BAYLA' })).toBeInTheDocument();
  });

  it('Back to the room, Escape and the veil close it; the screen’s move goes with it', () => {
    act(() => raiseReceipt(receipt()));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the room' }));
    expect(screen.queryByTestId('receipt-card')).toBeNull();
    expect(screen.getByTestId('move')).toHaveTextContent('none');
    act(() => raiseReceipt(receipt({ signature: 'second' })));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('receipt-card')).toBeNull();
  });
});

// Island answer thirty-one: after an add, any token, the green button is Share on X with the post
// written. Its link unfurls the island's card (middleware.js) and sends a person to the Add.
describe('an add shares on X', () => {
  const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
  // One link a post (island answer thirty-five): the sentence names no site, so X draws the add's own card.
  const POST = (coin: string) => `Just added liquidity to $${coin}. I'm part of the floor now. Every trade in the pool pays me.`;
  const added = (coin = { symbol: 'BAYLA', mint: BAYLA }) =>
    receipt({ action: 'added', coin, clock: 'double', under: `to the SOL + ${coin.symbol} pool`, fee: { kind: 'add', network: '0.000005 SOL' } });
  const posted = (href: string | null) => {
    const u = new URL(href ?? '');
    expect(`${u.origin}${u.pathname}`).toBe('https://x.com/intent/post');
    return u.searchParams.get('text');
  };

  it('an add in a room: Share on X, the post written, its link the room', () => {
    act(() => raiseReceipt(added()));
    const card = screen.getByTestId('receipt-card');
    const share = within(card).getByRole('link', { name: 'Share on X' });
    expect(posted(share.getAttribute('href'))).toBe(`${POST('BAYLA')} https://memetics.finance/lp/bayla`);
    expect(share).toHaveAttribute('target', '_blank');
    expect(share).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(card).queryByRole('link', { name: 'Share your card' })).toBeNull();
    expect(card.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('an add of a coin with no room: its link carries the mint', () => {
    act(() => raiseReceipt(added({ symbol: 'WIF', mint: WIF })));
    const share = screen.getByRole('link', { name: 'Share on X' });
    expect(posted(share.getAttribute('href'))).toBe(`${POST('WIF')} https://memetics.finance/lp/${WIF}`);
  });

  it('a ticker that carries its own $ is posted with one', () => {
    act(() => raiseReceipt(added({ symbol: '$WIF', mint: WIF })));
    const text = posted(screen.getByRole('link', { name: 'Share on X' }).getAttribute('href'));
    expect(text).toBe(`${POST('WIF')} https://memetics.finance/lp/${WIF}`);
  });

  it('the post fits X with its link, for the longest ticker the venue prints', () => {
    // X counts any link as 23 characters; the venue prints a ticker of at most 12 (identity.ts),
    // a copy as "fake " and the ticker.
    const longest = `fake ${'W'.repeat(12)}`;
    act(() => raiseReceipt(added({ symbol: longest, mint: WIF })));
    const text = posted(screen.getByRole('link', { name: 'Share on X' }).getAttribute('href')) ?? '';
    const link = `https://memetics.finance/lp/${WIF}`;
    expect(text.endsWith(` ${link}`)).toBe(true);
    expect(text.length - link.length + 23).toBeLessThanOrEqual(280);
    expect(text).not.toMatch(/—/);
  });

  it.each([
    ['a sale', { action: 'sold' }],
    ['a buy of a coin with no room', { action: 'bought', coin: { symbol: 'WIF', mint: WIF } }],
  ] as const)('%s keeps Share your card', (_name, over) => {
    act(() => raiseReceipt(receipt(over)));
    const share = screen.getByRole('link', { name: 'Share your card' });
    expect(share).toHaveAttribute('href', `https://memetics.wtf/card/${WALLET}`);
    expect(screen.queryByRole('link', { name: 'Share on X' })).toBeNull();
    expect(fetchClip).not.toHaveBeenCalled();
  });
});

// Island answer thirty-six, the owner's word 11-14: a buy or an add in a room shares its moment as a GIF on the post.
describe('the moment travels', () => {
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const ADD_POST = "Just added liquidity to $BAYLA. I'm part of the floor now. Every trade in the pool pays me. https://memetics.finance/lp/bayla";
  const BUY_POST = "Just bought $BAYLA. I'm on the shore now. Every light here holds it. https://memetics.finance/bayla?sheet=buy";
  const added = () => receipt({ action: 'added', clock: 'double', under: 'to the SOL + BAYLA pool', fee: { kind: 'add', network: '0.000005 SOL' } });
  const gifAnswer = () => new Response(GIF, { status: 200, headers: { 'content-type': 'image/gif' } });
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(20); });
  let restore: (() => void) | null = null;
  // A phone: a touch screen whose share sheet takes a GIF (or none, when `files` is false).
  function phone(files = true) {
    const share = vi.fn(async (_data: ShareData) => undefined);
    const had = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(pointer: coarse)', media: q, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    if (files) {
      Object.defineProperty(navigator, 'share', { value: share, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    }
    restore = () => {
      window.matchMedia = had;
      delete (navigator as { share?: unknown }).share;
      delete (navigator as { canShare?: unknown }).canShare;
    };
    return share;
  }
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('a phone: one tap hands X the flash’s GIF and the post', async () => {
    const share = phone();
    fetchClip.mockImplementation(async () => gifAnswer());
    act(() => raiseReceipt(added()));
    await flush();
    expect(fetchClip).toHaveBeenCalledWith('/share/moment/flash-bayla.gif');
    fireEvent.click(screen.getByRole('link', { name: 'Share on X' }));
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
    const data = share.mock.calls[0]![0];
    expect(data.text).toBe(ADD_POST);
    expect(data.files?.[0]?.name).toBe('memetics-finance-flash-bayla.gif');
    expect(data.files?.[0]?.type).toBe('image/gif');
    expect(screen.queryByTestId('receipt-moment-note')).toBeNull();
  });

  it('a phone tapped before its GIF is in hand: it says so, and the next tap shares the shore', async () => {
    const share = phone();
    let answer: (r: Response) => void = () => {};
    fetchClip.mockImplementation(() => new Promise<Response>((r) => { answer = r; }));
    act(() => raiseReceipt(receipt()));
    await flush();
    expect(fetchClip).toHaveBeenCalledWith('/share/moment/shore-bayla.gif');
    fireEvent.click(screen.getByRole('link', { name: 'Share on X' }));
    expect(screen.getByTestId('receipt-moment-note')).toHaveTextContent('Getting your GIF…');
    expect(share).not.toHaveBeenCalled();
    await act(async () => {
      answer(gifAnswer());
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByTestId('receipt-moment-note')).toHaveTextContent('Your GIF is ready. Tap Share on X.');
    fireEvent.click(screen.getByRole('link', { name: 'Share on X' }));
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]![0].text).toBe(BUY_POST);
    expect(share.mock.calls[0]![0].files?.[0]?.name).toBe('memetics-finance-shore-bayla.gif');
  });

  it('a computer: X’s composer opens with the words, and the GIF is saved to drop in', async () => {
    fetchClip.mockImplementation(async () => gifAnswer());
    const had = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:moment');
    URL.revokeObjectURL = vi.fn();
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    try {
      act(() => raiseReceipt(added()));
      await flush();
      const share = screen.getByRole('link', { name: 'Share on X' });
      expect(new URL(share.getAttribute('href') ?? '').searchParams.get('text')).toBe(ADD_POST);
      fireEvent.click(share);
      expect(saved).toEqual(['memetics-finance-flash-bayla.gif']);
      expect(screen.getByTestId('receipt-moment-note')).toHaveTextContent('Your GIF is saved. Add it to the post.');
    } finally {
      click.mockRestore();
      URL.createObjectURL = had.create;
      URL.revokeObjectURL = had.revoke;
    }
  });

  it('no GIF on the island yet: the composer with the words, as before, and nothing else', async () => {
    const share = phone();
    act(() => raiseReceipt(added()));
    await flush();
    expect(fetchClip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Share on X' }));
    await flush();
    expect(share).not.toHaveBeenCalled();
    expect(screen.queryByTestId('receipt-moment-note')).toBeNull();
  });

  it('a phone with no share sheet for files fetches nothing: the composer, as before', async () => {
    phone(false);
    act(() => raiseReceipt(added()));
    await flush();
    expect(fetchClip).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: 'Share on X' }));
    expect(screen.queryByTestId('receipt-moment-note')).toBeNull();
  });
});

describe('the clock line', () => {
  const reading =(rows: string[], address = WALLET): HeatReading => ({
    address,
    degrees: 12,
    tier: 'Observer',
    isCold: false,
    heldSinceUnix: 1,
    asOfUnix: 1,
    tokenCount: rows.length,
    breakdown: rows.map((tokenAddress) => ({ tokenAddress, chain: 'solana', name: '', symbol: '', degrees: 1, firstSeenAtUnix: 1, lastTransferAtUnix: null, retired: false })) as HeatReading['breakdown'],
    observedAt: 1,
    xHandle: null,
    daysToNextTier: null,
    daysToPlant: null,
  });
  it.each([
    ['an add counts double', 'added', reading([]), true, 'double'],
    ['a sell keeps counting (it cools, never resets)', 'sold', null, true, 'kept'],
    ['a first buy of the coin: day 1 tonight', 'bought', reading(['other']), true, 'day1'],
    ['a buy of a coin already held: it kept counting', 'bought', reading([BAYLA]), true, 'kept'],
    ['a buy with no reading of this wallet: nothing said', 'bought', null, true, null],
    ['a buy with another wallet’s reading: nothing said', 'bought', reading([], 'someone else'), true, null],
    ['a coin the island does not measure: nothing said', 'bought', reading([]), false, null],
  ] as const)('%s', (_name, action, read, island, line) => {
    expect(clockFor(action, BAYLA, WALLET, read, island)).toBe(line);
  });
});

describe('the shore’s holders (island answer thirty)', () => {
  const reading = (rows: { tokenAddress: string; roomHolders: number | null }[], address = WALLET): HeatReading => ({
    address,
    degrees: 12,
    tier: 'Observer',
    isCold: false,
    heldSinceUnix: 1,
    asOfUnix: 1,
    tokenCount: rows.length,
    breakdown: rows.map(({ tokenAddress, roomHolders }) => ({ tokenAddress, chain: 'solana', name: '', symbol: '', degrees: 1, firstSeenAtUnix: 1, lastTransferAtUnix: null, retired: false, roomRank: null, roomHolders })),
    observedAt: 1,
    xHandle: null,
    daysToNextTier: null,
    daysToPlant: null,
    earlierThanPct: null,
  });
  it.each([
    ['the coin’s room_holders on this wallet’s reading', reading([{ tokenAddress: 'other', roomHolders: 9 }, { tokenAddress: BAYLA, roomHolders: 412 }]), 412],
    ['the coin’s row without a count: not read', reading([{ tokenAddress: BAYLA, roomHolders: null }]), null],
    ['no row for the coin (a first buy): not read', reading([{ tokenAddress: 'other', roomHolders: 9 }]), null],
    ['another wallet’s reading: not read', reading([{ tokenAddress: BAYLA, roomHolders: 412 }], 'someone else'), null],
    ['no reading at all: not read', null, null],
  ] as const)('%s', (_name, read, holders) => {
    expect(holdersFor(BAYLA, WALLET, read)).toBe(holders);
  });
  it('the wallet is matched as the reading writes it, any case', () => {
    expect(holdersFor(BAYLA, WALLET.toLowerCase(), reading([{ tokenAddress: BAYLA, roomHolders: 7 }]))).toBe(7);
  });
});
