import { describe, it, expect } from 'vitest';
import { MANIFOLD_BOX, PIPE_IN, manifoldShape, manifoldWidths } from './manifold';

// Rates are in hundredths of a bip (1_000_000 = 100%): 10_000 is a 1% trade fee, 160_000 a 16% share of it.
const tier = (tradeFeeRate: bigint, protocolFeeRate: bigint, fundFeeRate = 0n) => ({ tradeFeeRate, protocolFeeRate, fundFeeRate });

/** Points along a pipe's centre line, "M x y C x y, x y, x y L x y" as manifoldShape lays it. */
function along(path: string): Array<[number, number]> {
  const n = path.match(/-?[\d.]+/g)!.map(Number);
  const [x0, y0, x1, y1, x2, y2, x3, y3, x4, y4] = n as [number, number, number, number, number, number, number, number, number, number];
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const u = 1 - t;
    out.push([u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3]);
  }
  for (let i = 0; i <= 20; i++) out.push([x3 + ((x4 - x3) * i) / 20, y3 + ((y4 - y3) * i) / 20]);
  return out;
}

describe('the manifold: each pipe as wide as its share of the fee', () => {
  it('draws nothing for a tier that was not read', () => {
    expect(manifoldWidths(null)).toBeNull();
  });

  it('draws nothing when the tier charges no fee to split', () => {
    expect(manifoldWidths(tier(0n, 160_000n))).toBeNull();
  });

  it('splits the pipe in as the tier splits the fee: 0.84% to the pool and 0.16% to the venue of a 1% fee', () => {
    const w = manifoldWidths(tier(10_000n, 120_000n, 40_000n))!;
    expect(w.in).toBe(PIPE_IN);
    expect(w.pool).toBeCloseTo(PIPE_IN * 0.84, 10);
    expect(w.venue).toBeCloseTo(PIPE_IN * 0.16, 10);
    expect(w.pool + w.venue).toBeCloseTo(w.in, 10);
  });

  it('follows the read, whatever the tier: a quarter to the venue of a 0.25% fee', () => {
    const w = manifoldWidths(tier(2_500n, 250_000n), 40)!;
    expect(w.pool / w.in).toBeCloseTo(0.75, 10);
    expect(w.venue / w.in).toBeCloseTo(0.25, 10);
  });

  // Each caption is 9 px capitals tracked 0.16em, whatever the drawing's scale (dwg-pools.css
  // .p01-mcap), so on a phone it covers more of the drawing. The venue's pipe falls toward its
  // caption's end: a caption above it was crossed by it (the read at 390, 2026-11-25).
  it('no pipe runs through its own caption, at any width a phone or a desk draws it', () => {
    const w = manifoldWidths(tier(10_000n, 120_000n, 40_000n))!;
    const s = manifoldShape(w);
    for (const drawnPx of [272, 342, 520]) {
      const scale = drawnPx / MANIFOLD_BOX.w;
      for (const [name, path, width, text] of [
        ['pool', s.pool!, w.pool, 'TO THE POOL'],
        ['venue', s.venue!, w.venue, 'TO THE VENUE'],
      ] as const) {
        // A caption that names no side sits above its pipe, as every one did before 2026-11-28.
        const [fx, fy, side = 'above'] = s.captions[name];
        const cw = (text.length * 9 * (0.62 + 0.16)) / scale;
        const ch = 9 / scale;
        const x = fx * MANIFOLD_BOX.w;
        const y = fy * MANIFOLD_BOX.h;
        const [top, bottom] = side === 'above' ? [y - ch, y] : [y, y + ch];
        expect(bottom, `${name} at ${drawnPx} px`).toBeLessThanOrEqual(MANIFOLD_BOX.h);
        for (const [px, py] of along(path)) {
          if (px < x - cw || px > x) continue;
          const crosses = py + width / 2 + 1 > top && py - width / 2 - 1 < bottom;
          expect(crosses, `${name} at ${drawnPx} px: the pipe at (${px.toFixed(0)}, ${py.toFixed(0)}) meets its caption, ${top.toFixed(0)} to ${bottom.toFixed(0)}`).toBe(false);
        }
      }
    }
  });

  it('lays no pipe for a share of nothing', () => {
    const w = manifoldWidths(tier(10_000n, 0n))!;
    expect(w.venue).toBe(0);
    const shape = manifoldShape(w);
    expect(shape.venue).toBeNull();
    expect(shape.pool).toMatch(/^M[\d.]+ [\d.]+ C /);
  });
});
