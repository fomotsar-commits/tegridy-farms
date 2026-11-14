import { describe, expect, it } from 'vitest';
import { fitCentred, monoWidth, placeLabels, sideWithRoom, type MarkLabel } from './markLabels';

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

describe('labels centred under marks that may crowd (the loan timeline reminders)', () => {
  it('with room, each label is centred on its mark', () => {
    expect(fitCentred([{ at: 100, width: 40 }, { at: 200, width: 40 }], SPAN)).toEqual([80, 180]);
  });

  it('a label that would come within the gap of one already shown is left out, the earlier one kept', () => {
    expect(fitCentred([{ at: 100, width: 40 }, { at: 140, width: 40 }, { at: 190, width: 40 }], SPAN)).toEqual([80, null, 170]);
  });

  it('a stretch already taken (day 1, due) keeps a label out, and so does an edge', () => {
    expect(fitCentred([{ at: 290, width: 40 }], SPAN, [[280, 320]])).toEqual([null]);
    expect(fitCentred([{ at: 10, width: 40 }], SPAN)).toEqual([null]);
    expect(fitCentred([{ at: 310, width: 40 }], SPAN)).toEqual([null]);
  });
});

describe('the side of its mark a label has room on (the range strip)', () => {
  it('the preferred side while the whole label fits there', () => {
    expect(sideWithRoom(100, 60, SPAN)).toBe('right');
    expect(sideWithRoom(100, 60, SPAN, 'left')).toBe('left');
  });

  it('the other side when the preferred one is too short for it', () => {
    // 320 - 4 - 4 - 260 = 52 to the right: a 60-wide label goes left.
    expect(sideWithRoom(260, 60, SPAN)).toBe('left');
    expect(sideWithRoom(40, 60, SPAN, 'left')).toBe('right');
  });

  it('exactly enough room is room', () => {
    expect(sideWithRoom(252, 60, SPAN)).toBe('right');
    expect(sideWithRoom(253, 60, SPAN)).toBe('left');
  });

  it('room on neither side: the side with more, for placeLabels to slide on', () => {
    expect(sideWithRoom(150, 200, SPAN)).toBe('right');
    expect(sideWithRoom(170, 200, SPAN)).toBe('left');
  });
});
