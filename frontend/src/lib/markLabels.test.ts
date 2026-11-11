import { describe, expect, it } from 'vitest';
import { monoWidth, placeLabels, type MarkLabel } from './markLabels';

const SPAN = 320;
const spans = (labels: MarkLabel[], lefts: number[]) => lefts.map((l, i) => [l, l + labels[i].width] as const);

describe('labels beside moving marks', () => {
  it('a monospace label is measured a little wide', () => {
    expect(monoWidth('16 times', 9)).toBeCloseTo(8 * 9 * 0.62, 9);
    expect(monoWidth('', 9)).toBe(0);
  });

  it('with room, each label sits beside its mark on its own side', () => {
    const labels: MarkLabel[] = [
      { at: 120, width: 30, side: 'left' },
      { at: 200, width: 40, side: 'right' },
    ];
    expect(placeLabels(labels, SPAN)).toEqual([120 - 4 - 30, 200 + 4]);
  });

  it('a mark at either end keeps its whole label on the picture', () => {
    const atLeft: MarkLabel[] = [{ at: 14, width: 67, side: 'left' }];
    expect(placeLabels(atLeft, SPAN)).toEqual([4]);
    const atRight: MarkLabel[] = [{ at: 306, width: 45, side: 'right' }];
    expect(placeLabels(atRight, SPAN)[0] + 45).toBe(SPAN - 4);
  });

  it.each([
    ['both at the left end', 14, 18],
    ['both at the right end', 302, 306],
    ['crossed, the left-side label right of the other', 280, 250],
  ])('two labels %s stay apart and on the picture', (_, a, b) => {
    const labels: MarkLabel[] = [
      { at: a, width: 67, side: 'left' },
      { at: b, width: 45, side: 'right' },
    ];
    const [[l1, r1], [l2, r2]] = spans(labels, placeLabels(labels, SPAN)).sort((p, q) => p[0] - q[0]);
    expect(l1).toBeGreaterThanOrEqual(4);
    expect(r2).toBeLessThanOrEqual(SPAN - 4);
    expect(r1 + 4).toBeLessThanOrEqual(l2);
  });

  it('answers in the order asked, wherever the marks are', () => {
    const labels: MarkLabel[] = [
      { at: 250, width: 20, side: 'right' },
      { at: 60, width: 20, side: 'left' },
    ];
    expect(placeLabels(labels, SPAN)).toEqual([254, 36]);
  });
});
