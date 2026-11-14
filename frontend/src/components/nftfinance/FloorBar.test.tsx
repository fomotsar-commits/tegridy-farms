import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FloorBar } from './FloorBar';
import { barAmount, barMax, barStep, barZone } from '../../lib/gondi/floorBar';
import { monoWidth } from '../../lib/markLabels';

afterEach(() => vi.restoreAllMocks());

/** Where a label is drawn, whatever anchor it uses: its left and right edges. */
const drawn = (t: Element): [number, number] => {
  const w = monoWidth(t.textContent ?? '', Number(t.getAttribute('font-size')));
  const at = Number(t.getAttribute('x')) + Number(t.getAttribute('dx') ?? 0);
  const anchor = t.getAttribute('text-anchor') ?? 'start';
  const left = anchor === 'end' ? at - w : anchor === 'middle' ? at - w / 2 : at;
  return [left, left + w];
};

describe('the axis under the floor bar', () => {
  it('runs to a quarter over the floor, or past whatever sits further out', () => {
    expect(barMax(0.08, 0.075, 0.06)).toBeCloseTo(0.1, 12);
    expect(barMax(0.08, 0.2, 0.06)).toBeCloseTo(0.21, 12);
    expect(barMax(0.08, null, 0.3)).toBeCloseTo(0.315, 12);
    for (const noFloor of [null, undefined, 0, -1, NaN]) expect(barMax(noFloor as number | null, 0.07, 0.06)).toBeNull();
  });

  it('steps by a two-hundredth of the floor, never finer than 0.0001 WETH', () => {
    expect(barStep(0.08)).toBe(0.0004);
    expect(barStep(5.8)).toBe(0.029);
    expect(barStep(0.012)).toBe(0.0001);
  });

  it('places the amount: under the best bid, between bid and floor, or over the floor', () => {
    expect(barZone(0.07, 0.08, 0.075)).toBe('covered');
    expect(barZone(0.075, 0.08, 0.075)).toBe('covered');
    expect(barZone(0.078, 0.08, 0.075)).toBe('under-floor');
    expect(barZone(0.081, 0.08, 0.075)).toBe('over-floor');
    // No bid read: nothing is ever "covered".
    expect(barZone(0.01, 0.08, null)).toBe('under-floor');
    // A bid above the floor still covers an amount above the floor.
    expect(barZone(0.085, 0.08, 0.09)).toBe('covered');
  });

  it('writes an amount as the amount box takes it', () => {
    expect(barAmount(0.07019)).toBe('0.0702');
    expect(barAmount(-1)).toBe('0.0000');
  });
});

describe('the bar on the Lend form', () => {
  const setup = (principal: number | null, floor: number | null = 0.08, bestBid: number | null = 0.075) => {
    const setPrincipal = vi.fn();
    const view = render(<FloorBar symbol="NAKA" principal={principal} floor={floor} bestBid={bestBid} setPrincipal={setPrincipal} />);
    return { setPrincipal, ...view };
  };
  const slider = () => screen.getByRole('slider') as HTMLInputElement;

  it('says in which stretch the amount stands, by colour and to a screen reader', () => {
    setup(0.07);
    expect(screen.getByTestId('floor-bar').dataset.zone).toBe('covered');
    expect(slider().getAttribute('aria-label')).toBe('Amount lent, against the NAKA floor and best bid');
    expect(slider().getAttribute('aria-valuetext')).toBe('0.0700 WETH: at or under the best bid');
  });

  it.each([
    [0.078, 'under-floor', '0.0780 WETH: over the best bid, under the floor'],
    [0.09, 'over-floor', '0.0900 WETH: over the floor'],
  ])('%s WETH is %s', (principal, zone, text) => {
    setup(principal);
    expect(screen.getByTestId('floor-bar').dataset.zone).toBe(zone);
    expect(slider().getAttribute('aria-valuetext')).toBe(text);
  });

  it('dragging the handle writes the amount box, to 4 decimals', () => {
    const { setPrincipal } = setup(0.07);
    fireEvent.change(slider(), { target: { value: '0.0604' } });
    expect(setPrincipal).toHaveBeenCalledWith('0.0604');
  });

  it('never writes an offer of nothing: the handle stops one step up', () => {
    const { setPrincipal } = setup(0.07);
    fireEvent.change(slider(), { target: { value: '0' } });
    expect(setPrincipal).toHaveBeenCalledWith('0.0004');
  });

  it('labels the floor always and the best bid only when there is one', () => {
    const withBid = setup(0.07);
    expect(withBid.container.textContent).toContain('floor');
    expect(withBid.container.textContent).toContain('best bid');
    withBid.unmount();
    const noBid = setup(0.07, 0.08, null);
    expect(noBid.container.textContent).toContain('floor');
    expect(noBid.container.textContent).not.toContain('best bid');
  });

  it.each([
    ['far down the bar', 0.004],
    ['just past the floor', 0.09],
    ['just under the floor', 0.075],
  ])('a best bid %s keeps both labels whole, on the bar and apart', (_, bid) => {
    const { container } = setup(0.07, 0.08, bid);
    const width = Number(container.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[2]);
    const labels = [...container.querySelectorAll('text')].map(drawn).sort((a, b) => a[0] - b[0]);
    expect(labels).toHaveLength(2);
    expect(labels[0][0]).toBeGreaterThanOrEqual(0);
    expect(labels[1][1]).toBeLessThanOrEqual(width);
    expect(labels[0][1]).toBeLessThanOrEqual(labels[1][0]);
  });

  it('each label sits on its own mark\'s side, even with the bid past the floor', () => {
    // With room for it: the bar drawn at a tablet card's width. At the 320 a phone gives, an
    // 11 px "best bid" this near the right end has no room on its own side and slides inward,
    // below its line's end; the cases above pin that it stays whole and apart there.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 0, x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 0, toJSON: () => ({}) } as DOMRect);
    const { container } = setup(0.07, 0.08, 0.085);
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 600 58');
    const [bidLine, floorLine] = [...container.querySelectorAll('line')].map((l) => Number(l.getAttribute('x1')));
    const label = (word: string) => drawn([...container.querySelectorAll('text')].find((t) => t.textContent?.trim() === word)!);
    // The floor (left) reads left of its line, the bid (right) right of its own.
    expect(label('floor')[1]).toBeLessThanOrEqual(floorLine);
    expect(label('best bid')[0]).toBeGreaterThanOrEqual(bidLine);
  });

  it('draws nothing until there is a floor and an amount to set against it', () => {
    for (const [principal, floor] of [[null, 0.08], [0, 0.08], [0.07, null]] as const) {
      const { container, unmount } = setup(principal, floor);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
