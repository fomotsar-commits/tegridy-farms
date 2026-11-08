// Island answer thirty-two (the owner's word, 11-07): after an add of liquidity, any token, the
// receipt card's head is the pool, and the seconds after the signature play in it (the pour, the
// bubble, the flash, a brick of light sinking to the floor of every LP's bricks). No flame. A buy
// and a sale keep their own ring. The engine needs a canvas, which jsdom has not: it is mocked here
// (hueOf kept real); the head's own tests are FloorHead.test.tsx, the engine is the island's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ReceiptCard } from './ReceiptCard';
import { clearReceipt, closeReceipt, raiseReceipt, reopenReceipt, settleReceipt, type Receipt } from '../lib/receipt';
import { clearScreenMoves } from '../lib/screenMove';
import { clearLanded } from '../lib/landed';
import { tick } from '../lib/tick';
import type { FloorMomentOptions } from '../lib/floorMoment';

vi.mock('../lib/tick', () => ({ tick: vi.fn() }));
const engine = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), setLps: vi.fn() }));
vi.mock('../lib/floorMoment', async () => {
  const real = await vi.importActual<typeof import('../lib/floorMoment')>('../lib/floorMoment');
  return {
    ...real,
    startFloorMoment: (o: unknown) => {
      engine.start(o);
      return { stop: engine.stop, setLps: engine.setLps };
    },
  };
});

const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const BAYLA_LINE = "You're part of $BAYLA's floor now. Every trade in the pool pays you.";

// The moment remembers the signature it landed for, across cards: each test lands its own.
let landed = 0;
let SIG = '';

function add(over: Partial<Receipt> = {}): Receipt {
  return {
    signature: SIG,
    explorerUrl: `https://solscan.io/tx/${SIG}`,
    wallet: WALLET,
    action: 'added',
    coin: { symbol: 'BAYLA', mint: BAYLA },
    title: null,
    under: 'to the SOL + BAYLA pool',
    fee: { kind: 'add', network: '0.000005 SOL' },
    clock: 'double',
    lps: null,
    ...over,
  };
}

const card = () => screen.getByTestId('receipt-card');
/** The card's HTML with its title's generated id (useId: a new one per card raised) set aside. */
const html = () => {
  const c = card();
  const id = c.getAttribute('aria-labelledby') ?? '';
  return id ? c.outerHTML.split(id).join('TITLE') : c.outerHTML;
};
const line = () => screen.getByTestId('receipt-floor-line');
const fxOnBody = () => document.body.querySelector('[data-testid="floor-fx"]');
const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));
/** The veil, then the card is up (250 ms): the head mounts and the moment starts. */
const rise = () => pass(250);
const opts = (n: number) => {
  const o = engine.start.mock.calls[n]?.[0] as FloorMomentOptions | undefined;
  if (!o) throw new Error(`the moment was not started a ${n + 1}th time`);
  return o;
};

beforeEach(() => {
  SIG = `floor-${++landed}-` + 'x'.repeat(70);
  vi.useFakeTimers();
  clearReceipt();
  clearScreenMoves();
  clearLanded();
  engine.start.mockClear();
  engine.stop.mockClear();
  engine.setLps.mockClear();
  vi.mocked(tick).mockClear();
  render(<ReceiptCard />);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('an add: the pool is the card’s head', () => {
  it('holds the head’s place while the card rises, then starts the moment once, with the wallet, the coin and the count as raised; no flame', () => {
    act(() => raiseReceipt(add()));
    expect(card()).toHaveAttribute('data-floor', 'playing');
    expect(card()).not.toHaveAttribute('data-flame');
    expect(screen.queryByTestId('flame-ring')).toBeNull();
    // The placeholder keeps the head's 214 px while the card rises, so nothing jumps when it mounts.
    expect(card().querySelector('.receipt-floor')).not.toBeNull();
    expect(screen.queryByTestId('floor-head')).toBeNull();
    expect(engine.start).not.toHaveBeenCalled();
    // The add's card is about 160 px taller; its edge is the CSS classes', not an inline border.
    expect(card().style.marginTop).toContain('680px');
    expect(card().style.border).toBe('');
    expect(card().style.boxShadow).toBe('');
    expect(card().style.getPropertyValue('--floor-hue')).toBe('130,255,120');
    // The line under the title is in the layout from the start, off until the landing.
    expect(line()).toHaveAttribute('data-on', '0');
    expect(line()).toHaveTextContent(BAYLA_LINE);

    rise();
    expect(screen.getByTestId('floor-head')).toBeInTheDocument();
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(opts(0)).toMatchObject({ state: 'playing', wallet: WALLET, symbol: 'BAYLA', lps: null });
    expect(opts(0).ring).toBe(screen.getByTestId('floor-ring'));
    expect(fxOnBody()).not.toBeNull();
    // The flame's catch never ticks for an add: the moment's ticks are the engine's own.
    pass(3000);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    expect(card()).toHaveAttribute('data-floor', 'playing');
  });

  it('any other token has its own hue on the card', () => {
    act(() => raiseReceipt(add({ coin: { symbol: 'WIF', mint: WIF } })));
    const hue = card().style.getPropertyValue('--floor-hue');
    expect(hue).toMatch(/^\d+,\d+,\d+$/);
    expect(hue).not.toBe('130,255,120');
    expect(card().style.getPropertyValue('--floor-hue-mid')).toMatch(/^\d+,\d+,\d+$/);
    expect(line()).toHaveTextContent("You're part of $WIF's floor now. Every trade in the pool pays you.");
  });

  it('the pool’s LP count read after the card is up reaches the running moment as setLps, never a restart', () => {
    act(() => raiseReceipt(add()));
    rise();
    act(() => settleReceipt(SIG, { lps: 9 }));
    expect(engine.setLps).toHaveBeenLastCalledWith(9);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('a count read before the card is up is the one the moment starts with', () => {
    act(() => raiseReceipt(add()));
    act(() => settleReceipt(SIG, { lps: 4 }));
    rise();
    expect(opts(0).lps).toBe(4);
  });

  it('the flash: the card’s edge goes white for 120 ms, then holds the token’s hue', () => {
    act(() => raiseReceipt(add()));
    rise();
    act(() => opts(0).onFlash?.());
    expect(card()).toHaveClass('receipt-flash');
    expect(card()).toHaveAttribute('data-floor', 'lit');
    pass(119);
    expect(card()).toHaveClass('receipt-flash');
    pass(1);
    expect(card()).not.toHaveClass('receipt-flash');
    expect(card()).toHaveAttribute('data-floor', 'lit');
  });

  it('each beat flares the card’s edge for 240 ms', () => {
    act(() => raiseReceipt(add()));
    rise();
    act(() => opts(0).onBeat?.(1));
    expect(card()).toHaveClass('receipt-beat');
    pass(239);
    expect(card()).toHaveClass('receipt-beat');
    pass(1);
    expect(card()).not.toHaveClass('receipt-beat');
  });

  it('the landing shows the line and marks the signature: raised again, the card opens at rest, lit, the line on, at once', () => {
    act(() => raiseReceipt(add()));
    rise();
    act(() => opts(0).onFlash?.());
    act(() => opts(0).onLanded?.());
    expect(line()).toHaveAttribute('data-on', '1');
    act(() => closeReceipt());
    expect(engine.stop).toHaveBeenCalledTimes(1);
    // Bayla's Receipt raises the same card: no rise to wait for, the moment told it is lit.
    act(() => reopenReceipt());
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(opts(1).state).toBe('lit');
    expect(card()).toHaveAttribute('data-floor', 'lit');
    expect(line()).toHaveAttribute('data-on', '1');
    expect(screen.getByTestId('floor-head')).toBeInTheDocument();
    rise();
    pass(3000);
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(tick).not.toHaveBeenCalled();
  });

  it('a card closed before the landing has not landed: raised again, it plays again', () => {
    act(() => raiseReceipt(add()));
    rise();
    act(() => opts(0).onFlash?.());
    act(() => closeReceipt());
    act(() => reopenReceipt());
    expect(card()).toHaveAttribute('data-floor', 'playing');
    expect(line()).toHaveAttribute('data-on', '0');
    expect(engine.start).toHaveBeenCalledTimes(1);
    rise();
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(opts(1).state).toBe('playing');
  });

  it('a new signature plays again', () => {
    act(() => raiseReceipt(add({ signature: `${SIG}-first` })));
    rise();
    act(() => opts(0).onLanded?.());
    act(() => closeReceipt());
    act(() => raiseReceipt(add({ signature: `${SIG}-second` })));
    expect(card()).toHaveAttribute('data-floor', 'playing');
    expect(line()).toHaveAttribute('data-on', '0');
    rise();
    expect(opts(1).state).toBe('playing');
  });

  it('Back stops the moment and takes the screen-wide canvas off the body', () => {
    act(() => raiseReceipt(add()));
    rise();
    expect(fxOnBody()).not.toBeNull();
    fireEvent.click(screen.getByTestId('receipt-back'));
    expect(screen.queryByTestId('receipt-card')).toBeNull();
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(fxOnBody()).toBeNull();
  });
});

describe('a buy and a sale keep what they had', () => {
  it.each([
    ['a buy', { action: 'bought', clock: 'day1', under: null, fee: { kind: 'reading' } }],
    ['a sale', { action: 'sold', clock: 'kept', under: null, fee: { kind: 'reading' } }],
  ] as const)('%s: the flame ring, no pool, no floor line, and an LP count changes nothing', (_name, over) => {
    act(() => raiseReceipt(add({ ...over, lps: null })));
    const before = html();
    expect(card()).toHaveAttribute('data-flame', 'ember');
    expect(card()).not.toHaveAttribute('data-floor');
    expect(screen.getByTestId('flame-ring')).toBeInTheDocument();
    expect(card().querySelector('.receipt-floor')).toBeNull();
    expect(screen.queryByTestId('receipt-floor-line')).toBeNull();
    expect(card().style.marginTop).toContain('520px');
    expect(card().style.border).toBe('1px solid rgba(139, 92, 246, 0.45)');
    act(() => closeReceipt());
    act(() => raiseReceipt(add({ ...over, lps: 9 })));
    expect(html()).toBe(before);
    rise();
    pass(3000);
    expect(engine.start).not.toHaveBeenCalled();
    expect(screen.queryByTestId('floor-head')).toBeNull();
    expect(fxOnBody()).toBeNull();
  });

  it('a buy still catches its flame, with its one tick', () => {
    act(() => raiseReceipt(add({ action: 'bought', clock: 'day1', under: null, fee: { kind: 'reading' } })));
    rise();
    expect(card()).toHaveAttribute('data-flame', 'catching');
    pass(300);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

/** The pool's light is CSS (index.css, "THE FLASH"): scanned as rules, not prose. */
describe('the CSS', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the ring holds the pool’s light in the token’s hue from the flash on, never a flame', () => {
    expect(css).toMatch(/\.floor-ring\[data-floor="lit"\] \.floor-orb\s*\{\s*opacity:\s*1/);
    expect(css).toMatch(/\.floor-ring\[data-floor="lit"\] \.floor-drop\s*\{\s*opacity:\s*0/);
    expect(css).toMatch(/\.floor-orb\s*\{[^}]*rgba\(var\(--floor-hue\)/);
  });

  it('the card’s edge: the token’s hue when lit, white for the flash, a flare on each beat', () => {
    expect(css).toMatch(/\.receipt-card\[data-floor="lit"\]\s*\{\s*border-color:\s*rgba\(var\(--floor-hue\),\s*0\.55\)/);
    expect(css).toMatch(/\.receipt-card\[data-floor\]\.receipt-flash\s*\{\s*border-color:\s*#ffffff/);
    expect(css).toMatch(/\.receipt-card\[data-floor\]\.receipt-beat\s*\{\s*border-color:\s*rgba\(var\(--floor-hue-mid\)/);
  });

  it('the screen-wide canvas sits over the receipt layer and takes no taps', () => {
    expect(css).toMatch(/\.receipt-floor-fx\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none[^}]*z-index:\s*86/);
  });

  it('reduced motion: the ring’s light does not breathe, the line and the edge do not slide', () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? '');
    const reduced = blocks.find((b) => b.includes('.floor-orb'));
    if (!reduced) throw new Error('no reduced-motion block for the floor');
    expect(reduced).toMatch(/\.floor-orb\s*\{\s*animation:\s*none/);
    expect(reduced).toMatch(/\.receipt-floor-line,\s*\.receipt-card\[data-floor\]\s*\{\s*transition:\s*none/);
  });
});
