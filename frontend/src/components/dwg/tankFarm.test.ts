import { describe, it, expect } from 'vitest';
import { FIELD_ASPECT, GAUGE_HIGH_USD, GAUGE_LOW_USD, TANK, tankFarm, waterLevel, type FieldPool } from './tankFarm';

const pool = (i: number, usd: number | null): FieldPool => ({ address: `pool${i}`, tokenMint: `mint${i}`, name: `COIN${i}/SOL`, usd });
const pools = (n: number, usd: (i: number) => number | null = () => null) => Array.from({ length: n }, (_, i) => pool(i, usd(i)));
const numbers = (points: string) => points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
const box = (points: string) => {
  const ps = numbers(points);
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

describe('the water stands at the dollars read, and only those', () => {
  it('is dry (null) when the dollars were not read, never a level of nothing', () => {
    for (const unread of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(waterLevel(unread)).toBeNull();
  });

  it('reads the staff gauge on a log scale from $10 to $10K, held at its ends', () => {
    expect(waterLevel(0)).toBe(0);
    expect(waterLevel(3)).toBe(0);
    expect(waterLevel(GAUGE_LOW_USD)).toBe(0);
    expect(waterLevel(100)).toBeCloseTo(1 / 3, 10);
    expect(waterLevel(1_000)).toBeCloseTo(2 / 3, 10);
    expect(waterLevel(GAUGE_HIGH_USD)).toBeCloseTo(1, 10);
    expect(waterLevel(14_524_000)).toBe(1);
  });

  it('draws water and its ripples in a read tank, and none in a tank not read', () => {
    const farm = tankFarm([pool(0, 14_524), pool(1, null), pool(2, 0)])!;
    const by = (i: number) => farm.tanks.find((t) => t.i === i)!;
    expect(by(0).level).toBeCloseTo(waterLevel(14_524)!, 10);
    expect(by(0).ripples).toHaveLength(3);
    expect(by(1).level).toBeNull();
    expect(by(1).ripples).toHaveLength(0);
    // A read of nothing is read: its water lies on the floor, with ripples, and is not a dry tank.
    expect(by(2).level).toBe(0);
    expect(by(2).ripples).toHaveLength(3);
  });

  it('stands the water higher in the tank with more dollars in it', () => {
    const farm = tankFarm([pool(0, 9_000), pool(1, 90)])!;
    const waterTop = (i: number) => box(farm.tanks.find((t) => t.i === i)!.water).minY - box(farm.tanks.find((t) => t.i === i)!.hole).minY;
    expect(waterTop(0)).toBeLessThan(waterTop(1));
  });
});

describe('the farm: one tank per pool, all one size, rows of four, the first pool nearest the eye', () => {
  it('draws nothing for no pools', () => {
    expect(tankFarm([])).toBeNull();
  });

  it('draws one tank per pool, every one the same size whatever its dollars', () => {
    const farm = tankFarm(pools(11, (i) => (i % 3 === 0 ? null : 10 ** (i % 6))))!;
    expect(farm.tanks).toHaveLength(11);
    // Points are rounded to hundredths, so sizes agree to within a few of those.
    const spread = (f: (t: (typeof farm.tanks)[number]) => number) => {
      const v = farm.tanks.map(f);
      return Math.max(...v) - Math.min(...v);
    };
    expect(spread((t) => box(t.top).w)).toBeLessThan(0.05);
    expect(spread((t) => box(t.top).h)).toBeLessThan(0.05);
    expect(spread((t) => box(t.left).h)).toBeLessThan(0.05);
    expect(spread((t) => box(t.right).w)).toBeLessThan(0.05);
  });

  it('sets the tanks out in rows of four, one main along each row', () => {
    for (const [n, rows] of [[1, 1], [4, 1], [5, 2], [8, 2], [12, 3], [13, 4]] as const) {
      expect(tankFarm(pools(n))!.mains, `${n} pools`).toHaveLength(rows);
    }
  });

  it('draws the first pool last, nearest the eye, and the far ones first', () => {
    const farm = tankFarm(pools(9))!;
    expect(farm.tanks.at(-1)!.i).toBe(0);
    const depth = farm.tanks.map((t) => box(t.top).minY);
    for (let k = 1; k < depth.length; k++) expect(depth[k]!).toBeGreaterThanOrEqual(depth[k - 1]! - 1e-9);
  });

  it('keeps a long name on its wall: smaller type, never past the wall', () => {
    const farm = tankFarm([{ ...pool(0, null), name: 'BIG BRAIN/BAYLA' }, pool(1, null)])!;
    const long = farm.tanks.find((t) => t.i === 0)!;
    const short = farm.tanks.find((t) => t.i === 1)!;
    expect(long.labelSize).toBeLessThan(short.labelSize);
    expect(long.labelSize * 0.72 * 'BIG BRAIN/BAYLA'.length).toBeLessThanOrEqual(TANK.W * TANK.U);
  });

  it('fits every farm, one tank or twenty, in a box of one shape, with every tank inside it', () => {
    for (let n = 1; n <= 20; n++) {
      const farm = tankFarm(pools(n))!;
      const [x, y, w, h] = farm.viewBox;
      expect(w / h, `${n} pools`).toBeCloseTo(FIELD_ASPECT, 2);
      for (const t of farm.tanks) {
        for (const face of [t.top, t.left, t.right]) {
          const b = box(face);
          expect(b.minX, `${n} pools, tank ${t.i}`).toBeGreaterThanOrEqual(x);
          expect(b.maxX).toBeLessThanOrEqual(x + w);
          expect(b.minY).toBeGreaterThanOrEqual(y);
          expect(b.maxY).toBeLessThanOrEqual(y + h);
        }
      }
    }
  });
});
