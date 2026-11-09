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

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    signature: SIG,
    explorerUrl: `https://solscan.io/tx/${SIG}`,
    wallet: WALLET,
    action: 'bought',
    coin: { symbol: 'BAYLA', mint: BAYLA },
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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
  vi.useRealTimers();
});

describe('the receipt card', () => {
  it('is nothing until something lands', () => {
    expect(screen.queryByTestId('receipt-card')).toBeNull();
    expect(screen.getByTestId('move')).toHaveTextContent('none');
  });

  it('rises with no confetti, says it is reading the fee, and holds one green button: Share your card', async () => {
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
    const share = within(card).getByRole('link', { name: 'Share your card' });
    expect(share).toHaveAttribute('href', `https://memetics.wtf/card/${WALLET}`);
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
        'Share your card',
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
        'Share your card',
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
  const POST = (coin: string) => `Just added liquidity to $${coin} on memetics.finance. I'm part of the floor now. Every trade in the pool pays me.`;
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
    ['a buy', 'bought'],
    ['a sale', 'sold'],
  ] as const)('%s keeps Share your card', (_name, action) => {
    act(() => raiseReceipt(receipt({ action })));
    const share = screen.getByRole('link', { name: 'Share your card' });
    expect(share).toHaveAttribute('href', `https://memetics.wtf/card/${WALLET}`);
    expect(screen.queryByRole('link', { name: 'Share on X' })).toBeNull();
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
