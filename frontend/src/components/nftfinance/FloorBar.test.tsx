import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FloorBar } from './FloorBar';
import { barAmount, barMax, barStep, barZone } from '../../lib/gondi/floorBar';

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

  it('draws nothing until there is a floor and an amount to set against it', () => {
    for (const [principal, floor] of [[null, 0.08], [0, 0.08], [0.07, null]] as const) {
      const { container, unmount } = setup(principal, floor);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
