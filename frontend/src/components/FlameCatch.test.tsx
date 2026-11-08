// Island answer twenty-nine, §1 (the owner's word, 11-06): the confetti goes; the receipt card's
// ring holds an ember that catches into the island's flame the moment the card is up. A sale
// never lights. Once per signature. Reduced motion: lit at once, nothing moves.
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

vi.mock('../lib/tick', () => ({ tick: vi.fn() }));

const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

// The catch remembers the signature it caught for, across cards: each test lands its own.
let landed = 0;
let SIG = '';

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
    lps: null,
    ...over,
  };
}

const card = () => screen.getByTestId('receipt-card');
const ring = () => screen.getByTestId('flame-ring');
const flame = () => card().getAttribute('data-flame');
// One move of the clock at a time: a timer the card arms on a re-render is armed when the move ends.
const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));
/** The rise (250 ms), then the catch (300 ms on). */
const rise = () => pass(250);
const catchBeat = () => pass(300);

beforeEach(() => {
  SIG = `landing-${++landed}-` + 'x'.repeat(70);
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

describe('the flame catches', () => {
  it('a buy: the ember while the card rises, the catch the moment it is up, one tick at the catch', () => {
    act(() => raiseReceipt(receipt()));
    expect(flame()).toBe('ember');
    expect(ring()).toHaveAttribute('data-flame', 'ember');
    // The rise (250 ms): the card is up, the catch begins; its tick comes with the catch, 300 ms on.
    rise();
    expect(flame()).toBe('catching');
    expect(ring()).toHaveAttribute('data-flame', 'catching');
    expect(tick).not.toHaveBeenCalled();
    pass(299);
    expect(tick).not.toHaveBeenCalled();
    pass(1);
    expect(tick).toHaveBeenCalledTimes(1);
    // Still by 1.2 s: nothing else fires.
    pass(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(flame()).toBe('catching');
  });

  it('an add never takes the flame: its card has the pool instead (answer thirty-two), and the ring’s catch never ticks for it', () => {
    act(() => raiseReceipt(receipt({ action: 'added', clock: 'double' })));
    expect(flame()).toBeNull();
    expect(screen.queryByTestId('flame-ring')).toBeNull();
    rise();
    catchBeat();
    pass(2000);
    expect(flame()).toBeNull();
    expect(screen.queryByTestId('flame-ring')).toBeNull();
    expect(screen.getByTestId('floor-ring')).toBeInTheDocument();
    expect(tick).not.toHaveBeenCalled();
  });

  it('a sale never lights: the ember stays, no catch, no tick, the clock line in place', () => {
    act(() => raiseReceipt(receipt({ action: 'sold', clock: 'kept' })));
    rise();
    catchBeat();
    pass(2000);
    expect(flame()).toBe('ember');
    expect(ring()).toHaveAttribute('data-flame', 'ember');
    expect(tick).not.toHaveBeenCalled();
    expect(screen.getByTestId('receipt-clock')).toHaveTextContent('Your clock on BAYLA kept counting.');
  });

  it('once per signature: Bayla’s Receipt raises the same card lit and still, with no second tick', () => {
    act(() => raiseReceipt(receipt()));
    rise();
    catchBeat();
    expect(tick).toHaveBeenCalledTimes(1);
    act(() => closeReceipt());
    expect(screen.queryByTestId('receipt-card')).toBeNull();
    act(() => reopenReceipt());
    expect(flame()).toBe('lit');
    expect(ring()).toHaveAttribute('data-flame', 'lit');
    rise();
    catchBeat();
    pass(2000);
    expect(flame()).toBe('lit');
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('a new signature catches again', () => {
    act(() => raiseReceipt(receipt({ signature: `${SIG}-first` })));
    rise();
    catchBeat();
    expect(tick).toHaveBeenCalledTimes(1);
    act(() => closeReceipt());
    act(() => raiseReceipt(receipt({ signature: `${SIG}-second` })));
    expect(flame()).toBe('ember');
    rise();
    expect(flame()).toBe('catching');
    catchBeat();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('a card closed before its catch has not caught: raised again, it catches then', () => {
    act(() => raiseReceipt(receipt()));
    rise();
    pass(100);
    expect(flame()).toBe('catching');
    act(() => closeReceipt());
    expect(tick).not.toHaveBeenCalled();
    act(() => reopenReceipt());
    expect(flame()).toBe('ember');
    rise();
    expect(flame()).toBe('catching');
    catchBeat();
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe('the ring', () => {
  it('holds the ember and the island’s flame: the body in the venue’s green, the core in its gold', () => {
    cleanup();
    const { container } = render(<FlameCatch state="ember" />);
    const r = container.querySelector('.flame-ring');
    expect(r).toHaveAttribute('aria-hidden', 'true');
    expect(r?.querySelector('.flame-ember')).not.toBeNull();
    const svg = r?.querySelector('svg.flame-fire');
    expect(svg).toHaveAttribute('viewBox', '0 0 28 28');
    const fills = Array.from(svg?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('fill'));
    expect(fills).toEqual(['#4CAF50', '#d4a017']);
  });
});

/** The motion is CSS: index.css holds the five keyframes and the states. Scanned as rules, not prose. */
describe('the CSS', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (name: string) => {
    const m = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!m) throw new Error(`no @keyframes ${name}`);
    return m[1];
  };

  it('the five keyframes, each with the island’s timeline', () => {
    expect(block('ember-out')).toMatch(/opacity:\s*0;\s*transform:\s*scale\(2\.2\)/);
    const catchKf = block('flame-catch');
    expect(catchKf).toMatch(/0%\s*\{\s*transform:\s*scale\(0\.15\)/);
    expect(catchKf).toMatch(/70%\s*\{\s*transform:\s*scale\(1\.08\)/);
    // The flame settles at scale 1, lit.
    expect(catchKf).toMatch(/100%\s*\{\s*transform:\s*scale\(1\);\s*opacity:\s*1/);
    const breathe = block('ring-breathe');
    expect(breathe).toMatch(/0%\s*\{\s*box-shadow:\s*0 0 24px rgba\(76,\s*76|0%\s*\{\s*box-shadow:\s*0 0 24px rgba\(76,\s*175,\s*80,\s*0\.35\)/);
    expect(breathe).toMatch(/35%\s*\{\s*box-shadow:\s*0 0 44px rgba\(76,\s*175,\s*80,\s*0\.80?\)/);
    const warm = block('edge-warm');
    expect(warm).toMatch(/35%\s*\{\s*border-color:\s*rgba\(76,\s*175,\s*80,\s*0\.65\)/);
    expect(warm).toMatch(/100%\s*\{\s*border-color:\s*rgba\(139,\s*92,\s*246,\s*0\.45\)/);
    expect(block('clock-light')).toMatch(/to\s*\{\s*opacity:\s*1;\s*transform:\s*none/);
  });

  it('the catch runs on a catching card only, its delays counted from the rise; the clock line lights last', () => {
    expect(css).toMatch(/\.flame-ring\[data-flame="catching"\] \.flame-ember\s*\{\s*animation:\s*ember-out 140ms ease-in 300ms forwards/);
    expect(css).toMatch(/\.flame-ring\[data-flame="catching"\] \.flame-fire\s*\{\s*animation:\s*flame-catch 320ms cubic-bezier\(0\.2,\s*1\.25,\s*0\.4,\s*1\) 300ms forwards/);
    expect(css).toMatch(/\.flame-ring\[data-flame="catching"\]\s*\{\s*animation:\s*ring-breathe 600ms ease-out 300ms forwards/);
    expect(css).toMatch(/\.receipt-card\[data-flame="catching"\]\s*\{\s*animation:\s*edge-warm 600ms ease-out 300ms forwards/);
    expect(css).toMatch(/\.receipt-card\[data-flame="catching"\] \.receipt-clock\s*\{\s*opacity:\s*0;\s*animation:\s*clock-light 200ms ease-out 500ms forwards/);
    expect(css).toMatch(/\.receipt-card\[data-flame="catching"\] \.receipt-clock-dot\s*\{\s*transform:\s*scale\(0\.5\);\s*animation:\s*clock-light 200ms ease-out 500ms forwards/);
    // Nothing animates on the ember (a sale, the rise) or on a card already lit.
    expect(css).not.toMatch(/data-flame="ember"\][^{]*\{[^}]*animation/);
    expect(css).not.toMatch(/data-flame="lit"\][^{]*\{[^}]*animation:\s*[a-z]/);
  });

  it('lit already: the flame at rest, the ember gone, nothing moves', () => {
    expect(css).toMatch(/\.flame-ring\[data-flame="lit"\] \.flame-ember\s*\{\s*opacity:\s*0/);
    expect(css).toMatch(/\.flame-ring\[data-flame="lit"\] \.flame-fire\s*\{\s*transform:\s*none;\s*opacity:\s*1/);
  });

  it('reduced motion: the flame renders lit at once, the ring at rest, the clock line visible, no animation', () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\.flame-ring[\s\S]*?)\n\}/);
    if (!m) throw new Error('no reduced-motion block for the flame');
    const reduced = m[1];
    for (const sel of [
      '.flame-ring[data-flame="catching"]',
      '.flame-ring[data-flame="catching"] .flame-ember',
      '.flame-ring[data-flame="catching"] .flame-fire',
      '.receipt-card[data-flame="catching"]',
      '.receipt-card[data-flame="catching"] .receipt-clock',
      '.receipt-card[data-flame="catching"] .receipt-clock-dot',
    ]) {
      const literal = sel.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      expect(reduced, `${sel} still animates under reduced motion`).toMatch(new RegExp(`${literal}[^{]*\\{[^}]*animation:\\s*none`));
    }
    expect(reduced).toMatch(/\.flame-ember\s*\{\s*opacity:\s*0/);
    expect(reduced).toMatch(/\.flame-fire\s*\{\s*transform:\s*none;\s*opacity:\s*1/);
    expect(reduced).toMatch(/\.receipt-clock-dot\s*\{\s*opacity:\s*1;\s*transform:\s*none/);
  });
});
