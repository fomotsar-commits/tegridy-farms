// Earn's site model, laid out (lib/isoPlan.ts): what the plan promises, measured on the sheet.
// At rest and on the tour every rung of every ladder stays in view: no house drawn after it, and
// not its own eave, stands between it and the eye. Every street's name lies on open road. The key
// in the corner stands on open ground at the largest it is ever drawn. The drawing's bounds hold
// every house, lifted roof and name included.
//
// Measured with every pool on a lock ladder, as on the live site (VITE_BAYLA_LADDER_PROGRAM puts
// the Solana rooms on one), and with the registry as this build reads it.
import { describe, it, expect } from 'vitest';
import { iso, type Pt } from './iso';
import { HOUSE_D, HOUSE_W, RAIL_TOP, U, bungalowBox, chimneyOutlines, houseOutline, railPoint, roofOutline, rungHeights } from './isoBungalow';
import { GAP_X, GAP_Y, KEY, LETTER, NAME_PX, TURN, groundOf, keyBox, keyFoot, planAspect, planBox, planStreets, roadOf, type Street } from './isoPlan';
import { venuePoolRows } from './venuePools';
import { boxesMeet, clearance, inside } from '../test/polygon';

const rows = venuePoolRows();
const LADDER_TERMS = 'Lock ladder · 7d–4y, 0.40×–4.00×';
const layouts: [string, Street[]][] = [
  ['the registry as this build reads it', planStreets(rows)],
  ['every pool on a lock ladder, as on the live site', planStreets(rows.map((r) => ({ ...r, terms: LADDER_TERMS })))],
];

/** The plots in the order they are drawn: street by street from the back, left to right. */
const drawOrder = (streets: readonly Street[]) => streets.flatMap((s) => s.plots);

/** Everything of a house that stands over what was drawn before it: the house and its chimney's stack and cap. */
const shapesOf = (x: number, y: number) => [houseOutline(x, y), ...chimneyOutlines(x, y)];

const boxOf = (poly: readonly Pt[]) => {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
};

describe.each(layouts)('the plan, with %s', (_, streets) => {
  it('sets every street out from the back, the longest first, and every house on it the same distance apart', () => {
    expect(streets.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < streets.length; i++) {
      expect(streets[i]!.plots.length).toBeLessThanOrEqual(streets[i - 1]!.plots.length);
      expect(streets[i]!.y - streets[i - 1]!.y).toBeCloseTo(HOUSE_D + GAP_Y, 10);
    }
    for (const s of streets) {
      s.plots.forEach((p, j) => expect(p.x).toBeCloseTo(j * (HOUSE_W + GAP_X), 10));
      expect(s.length).toBeCloseTo(s.plots.length * HOUSE_W + (s.plots.length - 1) * GAP_X, 10);
    }
    expect(drawOrder(streets)).toHaveLength(rows.length);
  });

  it('keeps every rung of every ladder in view: no house drawn after it, nor its own eave, stands in front of it', () => {
    const plots = drawOrder(streets);
    const worst = { px: Infinity, what: '' };
    plots.forEach((plot, i) => {
      if (!plot.ladder) return;
      const later = plots.slice(i + 1).flatMap((o) => shapesOf(o.x, o.y).map((poly, n) => ({ what: `${o.row.id}'s ${['house', 'chimney', 'chimney cap'][n]}`, poly })));
      const own = roofOutline(plot.x, plot.y);
      for (const z of rungHeights()) {
        const a = iso(railPoint(plot.x, plot.y, 0, z), U);
        const b = iso(railPoint(plot.x, plot.y, 1, z), U);
        for (const t of [0, 0.5, 1]) {
          const pt: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const mine = clearance(pt, own);
          if (mine < 2 && mine < worst.px) Object.assign(worst, { px: mine, what: `${plot.row.id} rung ${z.toFixed(2)} under its own eave` });
          for (const o of later) {
            const m = clearance(pt, o.poly);
            if (m < 1.5 && m < worst.px) Object.assign(worst, { px: m, what: `${plot.row.id} rung ${z.toFixed(2)} behind ${o.what}` });
          }
        }
      }
    });
    expect(worst.what).toBe('');
  });

  it('paints every street’s name on its own road, past the streets in front, where no house stands over it', () => {
    const plots = drawOrder(streets);
    streets.forEach((s, i) => {
      expect(s.nameTo - s.nameAt).toBeCloseTo(s.name.length * LETTER, 10);
      // The road runs on under the whole name, and its turning circle stands past it.
      expect(s.nameTo + 0.6).toBeLessThanOrEqual(s.roadEnd - TURN + 1e-9);
      const r = roadOf(s);
      // The name's footprint on the ground, as the sheet shows it.
      const glyph = NAME_PX / U;
      const corners: Pt[] = [
        iso([s.nameAt, r.mid + 0.25, 0], U), iso([s.nameTo, r.mid + 0.25, 0], U),
        iso([s.nameTo, r.mid + 0.25 - glyph, 0], U), iso([s.nameAt, r.mid + 0.25 - glyph, 0], U),
      ];
      expect(r.mid + 0.25).toBeLessThanOrEqual(r.y1);
      expect(r.mid + 0.25 - glyph).toBeGreaterThanOrEqual(r.y0);
      // Houses in front of this road are drawn after it; none may stand over its name.
      const front = plots.filter((p) => p.y > s.y);
      for (const p of front) {
        for (const c of corners) for (const poly of shapesOf(p.x, p.y)) expect(inside(c, poly)).toBe(false);
      }
      expect(i === 0 || s.nameAt <= streets[i - 1]!.nameAt).toBe(true);
    });
  });

  it('holds every house, its lifted roof and its name, and all the ground, inside the drawing', () => {
    const { box } = planBox(streets);
    const pointsIn = (p: Pt) => p[0] >= box.x && p[0] <= box.x + box.w && p[1] >= box.y && p[1] <= box.y + box.h;
    for (const plot of drawOrder(streets)) for (const p of bungalowBox(plot.x, plot.y)) expect(pointsIn(p)).toBe(true);
    const g = groundOf(streets);
    for (const p of [iso([g.x0, g.y0, 0], U), iso([g.x1, g.y0, 0], U), iso([g.x1, g.y1, 0], U), iso([g.x0, g.y1, 0], U)]) expect(pointsIn(p)).toBe(true);
  });

  it.each([1, KEY.scaleMax])('stands the key in the drawing’s top right corner on open ground, its words at %s times their size', (k) => {
    const { box, key } = planBox(streets);
    const kb = keyBox(key, k);
    expect(kb[0]).toBeGreaterThanOrEqual(box.x);
    expect(kb[2]).toBeLessThanOrEqual(box.x + box.w);
    expect(kb[1]).toBeGreaterThanOrEqual(box.y);
    expect(kb[3]).toBeLessThanOrEqual(box.y + box.h);
    // The ladder under the caption is as tall as the houses' ladders, and the key keeps room for it.
    expect(KEY.ladderPx).toBe(RAIL_TOP * U);
    expect(keyFoot(key.top, k) - key.top).toBeCloseTo(KEY.captionPx * k + KEY.gapPx + RAIL_TOP * U, 10);
    for (const p of drawOrder(streets)) {
      for (const poly of shapesOf(p.x, p.y)) expect(boxesMeet(kb, boxOf(poly))).toBe(false);
      expect(boxesMeet(kb, boxOf(bungalowBox(p.x, p.y)))).toBe(false);
    }
    const g = groundOf(streets);
    for (const s of streets) {
      const r = roadOf(s);
      const road = [iso([g.x0, r.y0, 0], U), iso([s.roadEnd + TURN, r.y0, 0], U), iso([s.roadEnd + TURN, r.y1, 0], U), iso([g.x0, r.y1, 0], U)];
      expect(boxesMeet(kb, boxOf(road))).toBe(false);
      // Nor the street's name painted on it.
      const name = [iso([s.nameAt, r.mid + 0.25, 0], U), iso([s.nameTo, r.mid + 0.25, 0], U), iso([s.nameTo, r.mid + 0.25 - NAME_PX / U, 0], U), iso([s.nameAt, r.mid + 0.25 - NAME_PX / U, 0], U)];
      expect(boxesMeet(kb, boxOf(name))).toBe(false);
    }
  });
});

describe('the street plan', () => {
  it('puts the plots of a street at the street’s own depth, one house deep', () => {
    for (const s of planStreets(rows)) for (const p of s.plots) expect(p.y).toBe(s.y);
    const [a, b] = planStreets(rows);
    expect(b!.y - a!.y).toBeGreaterThan(HOUSE_D);
  });

  it('gives the page the drawing’s width over its height, for sizing it by the screen’s height', () => {
    const { box } = planBox(planStreets(rows));
    expect(planAspect(rows)).toBeCloseTo(box.w / box.h, 10);
    expect(planAspect(rows)).toBeGreaterThan(1);
  });
});
