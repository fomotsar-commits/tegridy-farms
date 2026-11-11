// Island answer thirty, §1 (the owner's word, 11-07): the shore answers. The strike in the ring,
// the fire past the card, one light onto the coin's shore, every light on it taking its beat. It
// replaces twenty-nine's flame; the FlameCatch states drive it. The engine needs a canvas, so here
// it is mocked (§3) and the island's WebKit harness proves the moment itself. A sale never strikes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ReceiptCard } from './ReceiptCard';
import { FlameCatch } from './FlameCatch';
import { clearReceipt, closeReceipt, raiseReceipt, reopenReceipt, type Receipt } from '../lib/receipt';
import { clearScreenMoves } from '../lib/screenMove';
import { clearLanded } from '../lib/landed';
import { tick } from '../lib/tick';
import { startShoreMoment, type ShoreMomentOptions } from '../lib/shoreMoment';

const engine = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock('../lib/tick', () => ({ tick: vi.fn() }));
vi.mock('../lib/shoreMoment', () => ({ startShoreMoment: vi.fn(() => engine.stop) }));
const start = vi.mocked(startShoreMoment);

const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SHORE = "You're on $BAYLA's shore. Every light here holds it.";
const COOLING = 'Your light stays on the shore, cooling. The island remembers every day you held.';

// The moment remembers the signature it played for, across cards: each test lands its own.
let landed = 0;
let SIG = '';
let reduce = false;

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
    holders: 412,
    lps: null,
    ...over,
  };
}

const card = () => screen.getByTestId('receipt-card');
const ring = () => screen.getByTestId('flame-ring');
const states = () => start.mock.calls.map(([o]) => o.state);
const last = (): ShoreMomentOptions => {
  const c = start.mock.lastCall;
  if (!c) throw new Error('the engine never started');
  return c[0];
};
const shoreLine = () => screen.queryByTestId('receipt-shore-line');
const fxOnBody = () => Array.from(document.body.children).filter((el) => el.matches('canvas.receipt-fx'));
// One move of the clock at a time: a timer the card arms on a re-render is armed when the move ends.
const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));
/** The veil (250 ms), then the card's own 300 ms rise: the card is up. */
const rise = () => pass(250);
const up = () => pass(300);

beforeEach(() => {
  SIG = `landing-${++landed}-` + 'x'.repeat(70);
  reduce = false;
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion: reduce'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  vi.useFakeTimers();
  clearReceipt();
  clearScreenMoves();
  clearLanded();
  render(<ReceiptCard />);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the shore answers', () => {
  it('a buy: the shore waits while the card rises; the moment the card is up the engine strikes, once, with the wallet and the coin’s holders', () => {
    act(() => raiseReceipt(receipt()));
    expect(card()).toHaveAttribute('data-flame', 'catching');
    // The fire's canvas is not in the card, so it does not fade in with it: hidden until the card is up.
    expect(fxOnBody()[0]).toHaveStyle({ visibility: 'hidden' });
    rise();
    pass(299);
    expect(start).not.toHaveBeenCalled();
    expect(fxOnBody()[0]).toHaveStyle({ visibility: 'hidden' });
    pass(1);
    expect(fxOnBody()[0]).not.toHaveStyle({ visibility: 'hidden' });
    expect(start).toHaveBeenCalledTimes(1);
    const o = last();
    expect(o.state).toBe('catching');
    expect(o.wallet).toBe(WALLET);
    expect(o.holders).toBe(412);
    expect(o.reduced).toBe(false);
    // The venue's tick: at the strike, the landing and each beat.
    expect(o.onTick).toBe(tick);
    // The shore is the card's head; the ring is the one on the card; the fire's canvas is not in the card.
    expect(o.shore.tagName).toBe('CANVAS');
    expect(card().contains(o.shore)).toBe(true);
    expect(o.ring).toBe(ring());
    expect(o.fx.tagName).toBe('CANVAS');
    expect(card().contains(o.fx)).toBe(false);
    expect(o.fx.parentElement).toBe(document.body);
    // Nothing else starts it again, and the card itself never ticks: the engine does.
    pass(5000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
  });

  it('an add never strikes the shore: its card has the pool instead (answer thirty-two), and the shore never ticks for it', () => {
    act(() => raiseReceipt(receipt({ action: 'added', clock: 'double' })));
    expect(card()).not.toHaveAttribute('data-flame');
    expect(screen.queryByTestId('flame-ring')).toBeNull();
    rise();
    up();
    pass(2000);
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByTestId('flame-ring')).toBeNull();
    expect(screen.getByTestId('floor-ring')).toBeInTheDocument();
    expect(tick).not.toHaveBeenCalled();
  });

  it('a sale never strikes: the engine draws the cooling light at once, and the line says it cools', () => {
    act(() => raiseReceipt(receipt({ action: 'sold', clock: 'kept' })));
    expect(states()).toEqual(['ember']);
    expect(shoreLine()).toHaveTextContent(COOLING);
    rise();
    up();
    pass(5000);
    expect(states()).toEqual(['ember']);
    expect(card()).toHaveAttribute('data-flame', 'ember');
    expect(screen.getByTestId('receipt-clock')).toHaveTextContent('Your clock on BAYLA kept counting.');
  });

  it('the line under the title waits for the landing; the landing marks the signature: raised again, the card opens at rest', () => {
    act(() => raiseReceipt(receipt()));
    rise();
    up();
    expect(shoreLine()).toBeNull();
    // Its two lines are kept from the start, so nothing below moves when the light lands.
    expect(screen.getByTestId('receipt-shore-slot')).toHaveClass('min-h-[40px]');
    act(() => last().onLanded?.());
    expect(shoreLine()).toHaveTextContent(SHORE);
    // The coin's shore is marked, as the island drew it.
    const mark = shoreLine()?.querySelector('strong');
    expect(mark).toHaveTextContent("$BAYLA's shore.");
    expect(mark).toHaveStyle({ color: '#a0f8d0', fontWeight: '700' });
    act(() => closeReceipt());
    expect(engine.stop).toHaveBeenCalledTimes(1);
    act(() => reopenReceipt());
    // At rest at once: no rise to wait for, no second strike. The resting fire's canvas waits for the card.
    expect(states()).toEqual(['catching', 'lit']);
    expect(card()).toHaveAttribute('data-flame', 'lit');
    expect(shoreLine()).toHaveTextContent(SHORE);
    expect(fxOnBody()[0]).toHaveStyle({ visibility: 'hidden' });
    rise();
    up();
    expect(fxOnBody()[0]).not.toHaveStyle({ visibility: 'hidden' });
    pass(5000);
    expect(states()).toEqual(['catching', 'lit']);
  });

  it('a card closed before the landing has not played: raised again, it strikes again', () => {
    act(() => raiseReceipt(receipt()));
    rise();
    up();
    pass(1000);
    act(() => closeReceipt());
    expect(engine.stop).toHaveBeenCalledTimes(1);
    act(() => reopenReceipt());
    expect(states()).toEqual(['catching']);
    expect(shoreLine()).toBeNull();
    rise();
    up();
    expect(states()).toEqual(['catching', 'catching']);
  });

  it('a new signature plays again', () => {
    act(() => raiseReceipt(receipt({ signature: `${SIG}-first` })));
    rise();
    up();
    act(() => last().onLanded?.());
    act(() => closeReceipt());
    act(() => raiseReceipt(receipt({ signature: `${SIG}-second` })));
    expect(states()).toEqual(['catching']);
    rise();
    up();
    expect(states()).toEqual(['catching', 'catching']);
  });

  it('reduced motion is the venue’s reducedMotion(): the moment still plays, held to the ring', () => {
    reduce = true;
    act(() => raiseReceipt(receipt()));
    rise();
    up();
    expect(last().state).toBe('catching');
    expect(last().reduced).toBe(true);
  });

  it('no reading of the coin’s holders: the engine is told so (it draws its own 54)', () => {
    act(() => raiseReceipt(receipt({ holders: null })));
    rise();
    up();
    expect(last().holders).toBeNull();
  });

  it('each beat warms the card’s edge for 240 ms, then lets it go', () => {
    act(() => raiseReceipt(receipt()));
    rise();
    up();
    act(() => last().onLanded?.());
    expect(card()).not.toHaveClass('receipt-beat');
    act(() => last().onBeat?.(1));
    expect(card()).toHaveClass('receipt-beat');
    pass(239);
    expect(card()).toHaveClass('receipt-beat');
    pass(1);
    expect(card()).not.toHaveClass('receipt-beat');
    // A beat restarts the warmth, it never cuts the next one short.
    act(() => last().onBeat?.(2));
    pass(200);
    act(() => last().onBeat?.(3));
    pass(200);
    expect(card()).toHaveClass('receipt-beat');
    pass(40);
    expect(card()).not.toHaveClass('receipt-beat');
    // The beats never restart the engine.
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('the fire’s canvas is portaled to the body while the card is up, and gone with the card; stop runs on close', () => {
    expect(fxOnBody()).toHaveLength(0);
    act(() => raiseReceipt(receipt()));
    expect(fxOnBody()).toHaveLength(1);
    rise();
    up();
    expect(last().fx).toBe(fxOnBody()[0]);
    expect(engine.stop).not.toHaveBeenCalled();
    act(() => closeReceipt());
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(fxOnBody()).toHaveLength(0);
    expect(document.querySelector('canvas')).toBeNull();
  });
});

describe('the head', () => {
  it('the shore is a canvas across the card’s head; the ring on its bottom edge holds the ember and the island’s flame', () => {
    cleanup();
    const { container } = render(<FlameCatch state="catching" up={false} wallet={WALLET} holders={null} />);
    const head = container.querySelector('.receipt-head');
    expect(head).toHaveAttribute('aria-hidden', 'true');
    expect(head?.querySelector(':scope > canvas.receipt-shore')).not.toBeNull();
    const r = head?.querySelector(':scope > .flame-ring');
    expect(r).toHaveAttribute('data-flame', 'catching');
    expect(r?.querySelector('.flame-ember')).not.toBeNull();
    expect(r?.querySelector('.flame-css')).not.toBeNull();
    // Twenty-nine's svg flame is gone; the CSS flame is the island's.
    expect(r?.querySelector('svg')).toBeNull();
    // Waiting: nothing struck yet.
    expect(start).not.toHaveBeenCalled();
  });
});

/** The look is CSS (index.css, "The shore answers"). Scanned as rules, not prose. */
describe('the CSS', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const literal = sel.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const m = css.match(new RegExp(`(?:^|\\n)${literal}\\s*\\{([^}]*)\\}`));
    if (!m) throw new Error(`no rule for ${sel}`);
    return m[1];
  };

  it('twenty-nine’s catch is gone; the clock line still lights', () => {
    for (const k of ['ember-out', 'flame-catch', 'ring-breathe', 'edge-warm']) expect(css).not.toMatch(new RegExp(`@keyframes ${k}\\b`));
    expect(css).not.toMatch(/\.flame-fire/);
    expect(css).toMatch(/@keyframes clock-light\s*\{\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*none/);
    // At twenty-nine's moment: 750 ms from the raise (the veil's 250, then 500).
    expect(rule('.receipt-card[data-flame="catching"] .receipt-clock')).toMatch(/opacity:\s*0;\s*animation:\s*clock-light 200ms ease-out 750ms forwards/);
    expect(rule('.receipt-card[data-flame="catching"] .receipt-clock-dot')).toMatch(/transform:\s*scale\(0\.5\);\s*animation:\s*clock-light 200ms ease-out 750ms forwards/);
  });

  it('the head meets the card’s edges inside its 20 px corners, 176 px tall; the fire’s canvas covers the screen above the receipt layer', () => {
    const head = rule('.receipt-head');
    expect(head).toMatch(/height:\s*176px/);
    expect(head).toMatch(/margin:\s*-24px -20px 0/);
    expect(head).toMatch(/border-radius:\s*19px 19px 0 0/);
    expect(rule('.receipt-shore')).toMatch(/border-radius:\s*19px 19px 0 0/);
    const fx = rule('.receipt-fx');
    expect(fx).toMatch(/position:\s*fixed/);
    expect(fx).toMatch(/inset:\s*0/);
    expect(fx).toMatch(/pointer-events:\s*none/);
    expect(fx).toMatch(/z-index:\s*86/);
  });

  it('the ring on the head’s bottom edge, at rest and lit, and the island’s flame shown only once struck', () => {
    const r = rule('.flame-ring');
    expect(r).toMatch(/position:\s*absolute/);
    expect(r).toMatch(/left:\s*50%/);
    expect(r).toMatch(/bottom:\s*-28px/);
    expect(r).toMatch(/border:\s*1px solid rgba\(255,\s*199,\s*107,\s*0\.32\)/);
    const lit = rule('.flame-ring[data-shore="lit"]');
    expect(lit).toMatch(/border-color:\s*rgba\(255,\s*199,\s*107,\s*0\.7\)/);
    expect(lit).toMatch(/box-shadow:\s*0 0 26px rgba\(255,\s*138,\s*42,\s*0\.38\)/);
    const flame = rule('.flame-css');
    expect(flame).toMatch(/width:\s*15px/);
    expect(flame).toMatch(/height:\s*23px/);
    expect(flame).toMatch(/background:\s*radial-gradient\(ellipse at 50% 68%, #fff3c4 0, #ffc76b 34%, #ff8a2a 68%, rgba\(255,\s*110,\s*30,\s*0\) 100%\)/);
    expect(flame).toMatch(/opacity:\s*0/);
    const shown = rule('.flame-ring[data-shore="lit"] .flame-css');
    expect(shown).toMatch(/opacity:\s*1/);
    expect(shown).toMatch(/animation:\s*flame-flicker 1\.15s/);
    expect(rule('.flame-ring[data-shore="lit"] .flame-ember')).toMatch(/opacity:\s*0/);
  });

  it('a buy’s or a sale’s beat warms the edge: rgba(170,255,160,0.9) with a 70 px glow; an add’s beat is the pool’s own', () => {
    const beat = rule('.receipt-card[data-flame].receipt-beat');
    // Scoped to the shore's cards: its !important would otherwise paint an add's beats Bayla's green on any coin's pool.
    expect(css).not.toMatch(/(?:^|\n)\.receipt-card\.receipt-beat\s*\{/);
    expect(beat).toMatch(/border-color:\s*rgba\(170,\s*255,\s*160,\s*0\.9\)/);
    expect(beat).toMatch(/0 0 70px rgba\(130,\s*255,\s*120,\s*0\.34\)/);
  });

  it('reduced motion: the CSS flame holds still', () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([^@]*?\.flame-css[\s\S]*?)\n\}/);
    if (!m) throw new Error('no reduced-motion block for the ring’s flame');
    expect(m[1]).toMatch(/\.flame-ring\[data-shore="lit"\] \.flame-css\s*\{\s*animation:\s*none/);
  });
});
