// Earn's site model draws the registry and nothing else: one block per pool, a ramp for a lock
// ladder that is the ladder to scale, a flat slab for a pool with none, and the ladder's own
// figures from the contract's constants. It publishes no rate, as the list under it does not.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { IsoIsland } from './IsoIsland';
import { MAX_BOOST_BPS, MIN_BOOST_BPS } from '../../lib/constants';
import { hasLadder, venuePoolRows } from '../../lib/venuePools';

const rows = venuePoolRows();
const ladder = rows.find((r) => hasLadder(r.terms))!;
const flat = rows.find((r) => !hasLadder(r.terms))!;

/** A face's corners as numbers. */
const corners = (el: Element | null | undefined) => (el?.getAttribute('points') ?? '').split(' ').map((p) => p.split(',').map(Number) as [number, number]);
/** A block's three faces, in the order they are painted: the tall end, the section, the top. */
const faces = (root: HTMLElement, id: string) => Array.from(root.querySelectorAll(`[data-pool="${id}"] > polygon`)).map(corners);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the site model', () => {
  it('draws one block per pool, as a picture: every pool is a link in the list under it', () => {
    const { container, getByTestId } = render(<IsoIsland rows={rows} />);
    expect(container.querySelectorAll('[data-pool]')).toHaveLength(rows.length);
    expect(getByTestId('earn-site-model').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('a, button')).toBeNull();
  });

  it('a lock ladder is a ramp drawn to scale: its low end is to its high end as the floor is to the ceiling', () => {
    const { container } = render(<IsoIsland rows={rows} />);
    const [, section] = faces(container, ladder.id);
    // The section: low top, high top, high foot, low foot.
    const low = section![3]![1] - section![0]![1];
    const high = section![2]![1] - section![1]![1];
    expect(low).toBeGreaterThan(0);
    expect(low / high).toBeCloseTo(MIN_BOOST_BPS / MAX_BOOST_BPS, 2);
  });

  it('a pool with no ladder is a flat slab, one share high: never a ramp', () => {
    const { container } = render(<IsoIsland rows={rows} />);
    const [, section] = faces(container, flat.id);
    const nearEnd = section![3]![1] - section![0]![1];
    const farEnd = section![2]![1] - section![1]![1];
    expect(nearEnd).toBeCloseTo(farEnd, 2);
    // One share against the ladder's ceiling.
    const [, ramp] = faces(container, ladder.id);
    const ceiling = ramp![2]![1] - ramp![1]![1];
    expect(nearEnd / ceiling).toBeCloseTo(10_000 / MAX_BOOST_BPS, 2);
  });

  it('every ramp is the same ramp: the model cannot say one pool pays more than another', () => {
    const { container } = render(<IsoIsland rows={rows} />);
    const heights = rows.filter((r) => hasLadder(r.terms)).map((r) => {
      const [, section] = faces(container, r.id);
      return [section![3]![1] - section![0]![1], section![2]![1] - section![1]![1]].map((n) => n.toFixed(2)).join('/');
    });
    expect(new Set(heights).size).toBe(1);
  });

  it("prints the ladder's own figures from the contract's constants, and no rate", () => {
    const { container } = render(<IsoIsland rows={rows} />);
    const words = Array.from(container.querySelectorAll('text')).map((t) => t.textContent);
    expect(words).toContain(`${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`);
    expect(words).toContain(`${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`);
    expect(words).toContain('7d');
    expect(words).toContain('4y');
    expect(container.textContent).not.toMatch(/%|APR|\$/);
  });

  it('lights the pool a row is pointed at and names it; pointing at a block tells the list, and a press opens the pool', () => {
    const onActive = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(<IsoIsland rows={rows} active={ladder.id} onActive={onActive} onOpen={onOpen} />);
    const lit = container.querySelectorAll('[data-lit]');
    expect(lit).toHaveLength(1);
    expect(lit[0]!.getAttribute('data-pool')).toBe(ladder.id);
    expect(lit[0]!.querySelector('text')?.textContent).toBe(ladder.symbol);

    const other = container.querySelector(`[data-pool="${flat.id}"]`)!;
    fireEvent.mouseEnter(other);
    expect(onActive).toHaveBeenLastCalledWith(flat.id);
    fireEvent.click(other);
    expect(onOpen).toHaveBeenCalledWith(flat.id);
  });

  it('left alone it lights each pool in turn; under reduced motion it holds still', () => {
    vi.useFakeTimers();
    const moving = render(<IsoIsland rows={rows} />);
    expect(moving.container.querySelector('[data-lit]')).toBeNull();
    act(() => { vi.advanceTimersByTime(2400); });
    const first = moving.container.querySelector('[data-lit]')?.getAttribute('data-pool');
    expect(first).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2400); });
    expect(moving.container.querySelector('[data-lit]')?.getAttribute('data-pool')).not.toBe(first);
    moving.unmount();

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: /reduce/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const still = render(<IsoIsland rows={rows} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(still.container.querySelector('[data-lit]')).toBeNull();
  });
});
