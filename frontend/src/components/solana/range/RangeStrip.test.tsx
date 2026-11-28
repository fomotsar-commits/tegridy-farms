// The range strip's two labels stay whole on the strip, at any width.
//
// They used to flip to the left of their line only past 70% of the strip, whatever its width.
// On a phone (280 px), a new pool's "OPENING PRICE" at 69.8% ran 11 px off the right edge,
// where the strip clips. jsdom lays nothing out, so the strip's width is stubbed here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RangeStrip } from './RangeStrip';
import { monoWidth } from '../../../lib/markLabels';
import { stripLayout } from '../../../lib/solana/clmm/rangeStrip';

function boxesAre(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) } as DOMRect);
}
afterEach(() => vi.restoreAllMocks());

/** A label's width as drawn: 10 px capitals tracked 0.14em, estimated a little wide. */
const drawn = (text: string) => monoWidth(text, 10) + text.length * 1.4;
const leftOf = (id: string) => parseFloat(screen.getByTestId(id).style.left);

function strip(o: { lo: number; hi: number; market?: number | null; mark?: string }) {
  render(
    <RangeStrip
      now={1}
      market={o.market ?? null}
      lo={o.lo}
      hi={o.hi}
      nowName="The opening price"
      nowMark={o.mark ?? 'opening price'}
      words={{ now: '1', market: o.market ? String(o.market) : null, lo: String(o.lo), hi: String(o.hi), unit: 'SOL per BAYLA' }}
    />,
  );
}
/** Where a price's line is, in px across a strip `width` wide. */
const lineAt = (width: number, at: 'now' | 'market', o: { lo: number; hi: number; market?: number }) =>
  (stripLayout({ now: 1, ...o })![at]! / 100) * width;

describe('the range strip’s labels stay whole on the strip', () => {
  it('on a phone, a label near 70% that has no room on the right goes left of its line, all of it on the strip', () => {
    boxesAre(280);
    strip({ lo: 0.1, hi: 2 });
    const line = lineAt(280, 'now', { lo: 0.1, hi: 2 });
    expect(line / 280).toBeGreaterThan(0.69); // the case that ran off: right of its line, past the edge
    const left = leftOf('range-strip-label-now');
    expect(left).toBeGreaterThanOrEqual(4);
    expect(left + drawn('opening price')).toBeLessThanOrEqual(line - 6 + 1e-9);
  });

  it('with room on the right it keeps the right of its line, 6 px off it', () => {
    boxesAre(1100);
    strip({ lo: 0.1, hi: 2 });
    expect(leftOf('range-strip-label-now')).toBeCloseTo(lineAt(1100, 'now', { lo: 0.1, hi: 2 }) + 6, 6);
  });

  it('the market label too: near the right edge it goes left of its line, whole', () => {
    boxesAre(280);
    strip({ lo: 0.5, hi: 2, market: 6, mark: 'this pool' });
    const line = lineAt(280, 'market', { lo: 0.5, hi: 2, market: 6 });
    const left = leftOf('range-strip-label-market');
    expect(left + drawn('market')).toBeLessThanOrEqual(Math.min(line - 6, 280 - 4) + 1e-9);
  });

  // A pool's price is usually near the market's, so the two lines sit close: the market label
  // used to take the right of its line whatever stood there, and the pool's green line ran
  // through "MARKET" (the read at 390, 2026-11-25). Each label now keeps clear of the other line.
  it('no label is crossed by the other price’s line, whichever side of it that line is', () => {
    for (const width of [280, 342]) {
      for (let m = 0.8; m <= 1.25; m += 0.01) {
        boxesAre(width);
        const o = { lo: 0.5, hi: 2, market: m };
        const { unmount } = render(
          <RangeStrip now={1} market={m} lo={0.5} hi={2} nowName="This pool’s price" nowMark="this pool" words={{ now: '1', market: m.toFixed(2), lo: '0.5', hi: '2', unit: 'SOL' }} />,
        );
        for (const [id, text, other] of [
          ['range-strip-label-market', 'market', lineAt(width, 'now', o)],
          ['range-strip-label-now', 'this pool', lineAt(width, 'market', o)],
        ] as const) {
          const left = leftOf(id);
          const clear = other < left - 1 || other > left + drawn(text) + 1;
          expect(clear, `${id} at ${width} px, market ${m.toFixed(2)}: its label runs ${left.toFixed(1)} to ${(left + drawn(text)).toFixed(1)}, the other line is at ${other.toFixed(1)}`).toBe(true);
          expect(left).toBeGreaterThanOrEqual(4);
          expect(left + drawn(text)).toBeLessThanOrEqual(width - 4 + 1e-9);
        }
        unmount();
        vi.restoreAllMocks();
      }
    }
  });

  it('across every range on a phone, no label leaves the strip', () => {
    for (const lo of [0.5, 0.3, 0.2, 0.15, 0.127, 0.1, 0.07, 0.05]) {
      boxesAre(280);
      const { unmount } = render(
        <RangeStrip now={1} market={1.25} lo={lo} hi={2} nowName="The opening price" nowMark="opening price" words={{ now: '1', market: '1.25', lo: String(lo), hi: '2', unit: 'SOL' }} />,
      );
      for (const [id, text] of [['range-strip-label-now', 'opening price'], ['range-strip-label-market', 'market']] as const) {
        const left = leftOf(id);
        expect(left, `${id} at lo ${lo}`).toBeGreaterThanOrEqual(4);
        expect(left + drawn(text), `${id} at lo ${lo}`).toBeLessThanOrEqual(280 - 4 + 1e-9);
      }
      unmount();
      vi.restoreAllMocks();
    }
  });
});
