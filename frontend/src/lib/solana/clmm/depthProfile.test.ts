import { describe, expect, it } from 'vitest';
import { tickCount } from './bitmap';
import { depthProfile, liquidityAt } from './depthProfile';
import type { TickArrayView, TickStateView } from './program';

const SPACING = 10;
const SPAN = tickCount(SPACING);

const tick = (at: number, net: bigint): TickStateView =>
  ({ tick: at, liquidityNet: net, liquidityGross: net < 0n ? -net : net, feeGrowthOutside0X64: 0n, feeGrowthOutside1X64: 0n, rewardGrowthsOutsideX64: [], orderPhase: 0n, ordersAmount: 0n, partFilledOrdersRemaining: 0n, unfilledRatioX64: 0n }) as TickStateView;

/** A band starting at `start` holding these used prices; every other slot is unused (gross 0). */
const band = (start: number, used: TickStateView[]): [number, TickArrayView] => [
  start,
  { address: `band${start}`, poolId: 'pool', startTickIndex: start, ticks: [...used, tick(start + SPACING * 7, 0n)], initializedTickCount: used.length },
];

describe('depthProfile', () => {
  it('is null when no band was read', () => {
    expect(depthProfile({ liquidity: 0n, tickCurrent: 0, tickSpacing: SPACING }, new Map())).toBeNull();
  });

  it('walks out from the pool’s price: two positions, one inside the other', () => {
    // A: 100 from -200 to 300. B: 50 from 20 to 120. The price is at 50, inside both.
    const bands = new Map([band(-SPAN, [tick(-200, 100n)]), band(0, [tick(20, 50n), tick(120, -50n), tick(300, -100n)])]);
    const d = depthProfile({ liquidity: 150n, tickCurrent: 50, tickSpacing: SPACING }, bands)!;
    expect(d.from).toBe(-SPAN);
    expect(d.to).toBe(SPAN);
    expect(d.steps).toEqual([
      { from: -SPAN, to: -200, liquidity: 0n },
      { from: -200, to: 20, liquidity: 100n },
      { from: 20, to: 120, liquidity: 150n },
      { from: 120, to: 300, liquidity: 100n },
      { from: 300, to: SPAN, liquidity: 0n },
    ]);
    expect(liquidityAt(d, 50)).toBe(150n);
    expect(liquidityAt(d, 119)).toBe(100n + 50n);
    expect(liquidityAt(d, 120)).toBe(100n);
    expect(liquidityAt(d, -201)).toBe(0n);
  });

  it('counts a used price the pool sits exactly on as crossed', () => {
    // One position from 100 to 200, and the price is at its lower edge: it is in use.
    const d = depthProfile({ liquidity: 70n, tickCurrent: 100, tickSpacing: SPACING }, new Map([band(0, [tick(100, 70n), tick(200, -70n)])]))!;
    expect(liquidityAt(d, 99)).toBe(0n);
    expect(liquidityAt(d, 100)).toBe(70n);
    expect(liquidityAt(d, 199)).toBe(70n);
    expect(liquidityAt(d, 200)).toBe(0n);
  });

  it('claims nothing outside the bands read', () => {
    const d = depthProfile({ liquidity: 70n, tickCurrent: 100, tickSpacing: SPACING }, new Map([band(0, [tick(100, 70n), tick(200, -70n)])]))!;
    expect(liquidityAt(d, -1)).toBeNull();
    expect(liquidityAt(d, SPAN)).toBeNull();
  });

  it('keeps the pool’s own price inside the reading when every band read is below it', () => {
    const d = depthProfile({ liquidity: 0n, tickCurrent: SPAN * 3 + 5, tickSpacing: SPACING }, new Map([band(0, [tick(100, 70n), tick(200, -70n)])]))!;
    expect(d.to).toBe(SPAN * 3 + 6);
    expect(liquidityAt(d, SPAN * 3 + 5)).toBe(0n);
    expect(liquidityAt(d, 150)).toBe(70n);
  });

  it('throws when the bands do not add up to the pool’s liquidity', () => {
    // The pool says 10 is in use, but going down the band takes 70 away.
    expect(() => depthProfile({ liquidity: 10n, tickCurrent: 150, tickSpacing: SPACING }, new Map([band(0, [tick(100, 70n), tick(200, -70n)])]))).toThrow(/do not add up/);
  });
});
