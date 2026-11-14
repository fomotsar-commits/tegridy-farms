import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RangeDrag } from './RangeDrag';
import {
  DRAG_GAP,
  DRAG_STOPS,
  moveHandle,
  nearerHandle,
  priceAtStop,
  stopAtFraction,
  stopAtPrice,
  stopFraction,
  stopTimes,
} from '../../../lib/solana/clmm/rangeDrag';
import { formatSolPrice } from '../../../lib/solana/lp/format';
import { monoWidth } from '../../../lib/markLabels';

const NOW = 0.0004;

/** Where a label is drawn, whatever anchor it uses: its left and right edges. */
const drawn = (t: Element): [number, number] => {
  const w = monoWidth(t.textContent ?? '', Number(t.getAttribute('font-size')));
  const at = Number(t.getAttribute('x')) + Number(t.getAttribute('dx') ?? 0);
  const anchor = t.getAttribute('text-anchor') ?? 'start';
  const left = anchor === 'end' ? at - w : anchor === 'middle' ? at - w / 2 : at;
  return [left, left + w];
};

describe('the axis under the handles', () => {
  it('a stop is a hundredth of a doubling around the starting price', () => {
    expect(priceAtStop(NOW, 0)).toBe(NOW);
    expect(priceAtStop(NOW, 100)).toBeCloseTo(NOW * 2, 12);
    expect(priceAtStop(NOW, -200)).toBeCloseTo(NOW / 4, 12);
  });

  it('finds the stop nearest a price, on whole steps, held to the axis', () => {
    expect(stopAtPrice(NOW, NOW)).toBe(0);
    expect(stopAtPrice(NOW, NOW * 2)).toBe(100);
    expect(stopAtPrice(NOW, NOW * 1.03)).toBe(5); // 4.26 stops, the nearest step is 5
    expect(stopAtPrice(NOW, NOW * 1000)).toBe(DRAG_STOPS);
    expect(stopAtPrice(NOW, NOW / 1000)).toBe(-DRAG_STOPS);
    for (const bad of [0, -1, NaN, null, undefined]) expect(stopAtPrice(NOW, bad as number | null)).toBeNull();
    expect(stopAtPrice(0, NOW)).toBeNull();
  });

  it('maps the axis to and from a share of its width', () => {
    expect(stopFraction(-DRAG_STOPS)).toBe(0);
    expect(stopFraction(0)).toBe(0.5);
    expect(stopAtFraction(0.5)).toBe(0);
    expect(stopAtFraction(0.625)).toBe(100);
    expect(stopAtFraction(-3)).toBe(-DRAG_STOPS);
    expect(stopAtFraction(7)).toBe(DRAG_STOPS);
  });

  it('a handle stops at the other one and never pushes it', () => {
    expect(moveHandle({ lo: -100, hi: 100 }, 'lo', 250)).toEqual({ lo: 100 - DRAG_GAP, hi: 100 });
    expect(moveHandle({ lo: -100, hi: 100 }, 'hi', -300)).toEqual({ lo: -100, hi: -100 + DRAG_GAP });
    expect(moveHandle({ lo: -100, hi: 100 }, 'lo', -9999)).toEqual({ lo: -DRAG_STOPS, hi: 100 });
    expect(moveHandle({ lo: -100, hi: 100 }, 'hi', 152)).toEqual({ lo: -100, hi: 150 });
  });

  it('a press takes the nearer handle', () => {
    expect(nearerHandle({ lo: -100, hi: 100 }, -60)).toBe('lo');
    expect(nearerHandle({ lo: -100, hi: 100 }, 20)).toBe('hi');
    expect(nearerHandle({ lo: -100, hi: 100 }, 0)).toBe('hi');
    expect(nearerHandle({ lo: 50, hi: 60 }, -300)).toBe('lo');
  });

  it('names a stop as a multiple of the starting price', () => {
    expect(stopTimes(0)).toBe('the same');
    expect(stopTimes(100)).toBe('2 times');
    expect(stopTimes(-100)).toBe('half');
    expect(stopTimes(-200)).toBe('a quarter');
    expect(stopTimes(50)).toBe('1.41 times');
    expect(stopTimes(400)).toBe('16 times');
  });

  it('the far end is said in words, as half and a quarter are, not "0.063 times"', () => {
    expect(stopTimes(-300)).toBe('an eighth');
    expect(stopTimes(-400)).toBe('a sixteenth');
    expect(stopTimes(-350)).toBe('0.088 times');
  });
});

describe('dragging the range', () => {
  const setup = (lo: number | null, hi: number | null, disabled = false) => {
    const setMin = vi.fn();
    const setMax = vi.fn();
    render(<RangeDrag now={NOW} lo={lo} hi={hi} at="this pool’s price" setMin={setMin} setMax={setMax} disabled={disabled} />);
    return { setMin, setMax };
  };
  const lo = () => screen.getByTestId('range-drag-lo') as HTMLInputElement;
  const hi = () => screen.getByTestId('range-drag-hi') as HTMLInputElement;

  it('shows the form\'s range on the two handles, named for a screen reader', () => {
    setup(NOW / 2, NOW * 2);
    expect(screen.getByTestId('range-drag').dataset.picked).toBe('yes');
    expect(lo().value).toBe('-100');
    expect(hi().value).toBe('100');
    expect(screen.getByRole('slider', { name: 'Range’s lower edge, against this pool’s price' })).toBe(lo());
    expect(lo().getAttribute('aria-valuetext')).toBe(`half: ${formatSolPrice(NOW / 2)}`);
    expect(hi().getAttribute('aria-valuetext')).toBe(`2 times: ${formatSolPrice(NOW * 2)}`);
  });

  it('moving the lowest handle writes only the lowest price, as the form would type it', () => {
    const { setMin, setMax } = setup(NOW / 2, NOW * 2);
    fireEvent.change(lo(), { target: { value: '-200' } });
    expect(setMin).toHaveBeenCalledWith(formatSolPrice(NOW / 4));
    expect(setMax).not.toHaveBeenCalled();
  });

  it('moving the highest handle writes only the highest price', () => {
    const { setMin, setMax } = setup(NOW / 2, NOW * 2);
    fireEvent.change(hi(), { target: { value: '200' } });
    expect(setMax).toHaveBeenCalledWith(formatSolPrice(NOW * 4));
    expect(setMin).not.toHaveBeenCalled();
  });

  it('with no range picked the handles rest at half and double, and the first move sets both edges', () => {
    const { setMin, setMax } = setup(null, null);
    expect(screen.getByTestId('range-drag').dataset.picked).toBe('no');
    expect(lo().value).toBe('-100');
    expect(hi().value).toBe('100');
    fireEvent.change(hi(), { target: { value: '150' } });
    expect(setMin).toHaveBeenCalledWith(formatSolPrice(NOW / 2));
    expect(setMax).toHaveBeenCalledWith(formatSolPrice(priceAtStop(NOW, 150)));
  });

  it('the sliders cannot cross: each one\'s reach ends short of the other', () => {
    setup(NOW / 2, NOW * 2);
    expect(lo().max).toBe(String(100 - DRAG_GAP));
    expect(hi().min).toBe(String(-100 + DRAG_GAP));
  });

  it('holds still while the form is sending', () => {
    setup(NOW / 2, NOW * 2, true);
    expect(lo().disabled).toBe(true);
    expect(hi().disabled).toBe(true);
  });

  it.each([
    ['both ends', -DRAG_STOPS, DRAG_STOPS],
    ['the low end, handles together', -DRAG_STOPS, -DRAG_STOPS + DRAG_GAP],
    ['the high end, handles together', DRAG_STOPS - DRAG_GAP, DRAG_STOPS],
  ])('handles dragged to %s keep both labels whole, on the picture and apart', (_, loStop, hiStop) => {
    const { container } = render(
      <RangeDrag now={NOW} lo={priceAtStop(NOW, loStop)} hi={priceAtStop(NOW, hiStop)} at="x" setMin={() => {}} setMax={() => {}} />,
    );
    const width = Number(container.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[2]);
    const [lo, hi] = [...container.querySelectorAll('text')];
    expect([lo.textContent, hi.textContent]).toEqual([stopTimes(loStop), stopTimes(hiStop)]);
    const [loSpan, hiSpan] = [drawn(lo), drawn(hi)];
    expect(loSpan[0]).toBeGreaterThanOrEqual(0);
    expect(hiSpan[1]).toBeLessThanOrEqual(width);
    expect(loSpan[1]).toBeLessThanOrEqual(hiSpan[0]);
  });

  it('away from the ends, each label still sits just outside its handle', () => {
    const { container } = render(<RangeDrag now={NOW} lo={NOW / 2} hi={NOW * 2} at="x" setMin={() => {}} setMax={() => {}} />);
    const [lo, hi] = [...container.querySelectorAll('text')].map(drawn);
    const handles = [...container.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cx')));
    expect(lo[1]).toBeCloseTo(handles[0] - 4, 9);
    expect(hi[0]).toBeCloseTo(handles[1] + 4, 9);
  });

  it('draws nothing without a starting price', () => {
    const { container } = render(<RangeDrag now={0} lo={null} hi={null} at="x" setMin={() => {}} setMax={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
