// The one bungalow every pool is drawn as (components/farm/IsoBungalow.tsx), in numbers, and the
// matrix that lays its room's picture on its walls. What these pin: the lock ladder is drawn to
// scale from the contract's constants and its top rung shows under the eave; the roof's far
// slope is never seen; the front wall shows the crop the room chose for its door card, at that
// crop's size, and the gable is covered by the picture too; the shapes that take the pointer are
// the house as it is seen; the drawing's bounds hold a house with its roof lifted and its name.
import { describe, it, expect } from 'vitest';
import { MAX_BOOST_BPS, MIN_BOOST_BPS } from './constants';
import { iso, wallMatrix, type P3, type Pt } from './iso';
import { clearance, inside } from '../test/polygon';
import {
  DOOR, DOOR_CARD_ASPECT, EAVE, EAVE_Z, FRONT_BAND, FRONT_WALL, GABLE_WALL, HOUSE_D, HOUSE_W, LABEL_GAP_PX, LABEL_PX, LABEL_Z, LADDER_AT,
  LADDER_OUT, MURAL_ACROSS, MURAL_H, MURAL_TARGET, OVER_EAVE, RAIL_GAP, RAIL_TOP, RIDGE, RISE, ROOF_LIFT, ROOF_THICK, RUNG_HIGH, RUNG_LOW,
  U, bungalowBox, cardCrop, chimneyBox, chimneyOutlines, gableFrame, houseOutline, muralFrame, railPoint, roofCorners, roofOutline, rungHeights,
} from './isoBungalow';

/** Applies an SVG `matrix(a b c d e f)` to a point. */
function apply(matrix: string, [x, y]: Pt): Pt {
  const m = /^matrix\(([^)]+)\)$/.exec(matrix);
  if (!m) throw new Error(`not a matrix: ${matrix}`);
  const [a, b, c, d, e, f] = m[1]!.split(/\s+/).map(Number) as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}

const close = (p: Pt, q: Pt) => {
  expect(p[0]).toBeCloseTo(q[0], 1);
  expect(p[1]).toBeCloseTo(q[1], 1);
};

describe('the lock ladder on a bungalow’s wall', () => {
  it('its first rung is as far up as the floor of the share is of its ceiling', () => {
    const rungs = rungHeights();
    expect(rungs[0]).toBeCloseTo(RUNG_LOW, 10);
    expect(rungs.at(-1)).toBeCloseTo(RUNG_HIGH, 10);
    expect(rungs[0]! / rungs.at(-1)!).toBeCloseTo(MIN_BOOST_BPS / MAX_BOOST_BPS, 10);
  });

  it('its rungs are evenly spaced, as the share grows evenly with the lock', () => {
    const rungs = rungHeights(6);
    const steps = rungs.slice(1).map((z, i) => z - rungs[i]!);
    for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 10);
  });

  it('its top rung shows under the eave, by at least two pixels at both ends and in the middle', () => {
    // The eave stands out over the ladder, so "under the eave" is a question of the sheet, not of heights.
    for (const [x, y] of [[0, 0], [7.7, 5.3]] as const) {
      const roof = roofOutline(x, y);
      for (const t of [0, 0.5, 1]) {
        const a = iso(railPoint(x, y, 0, RUNG_HIGH), U);
        const b = iso(railPoint(x, y, 1, RUNG_HIGH), U);
        const pt: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        expect(clearance(pt, roof)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('stands on the ground a quarter of its height out from the wall, its rails stopping under the soffit', () => {
    expect(LADDER_OUT * 4).toBeCloseTo(RAIL_TOP, 10);
    expect(RAIL_TOP).toBeLessThan(EAVE - ROOF_THICK);
    expect(RUNG_HIGH).toBeLessThan(RAIL_TOP);
    expect(railPoint(0, 0, 0, RAIL_TOP)[1]).toBeCloseTo(HOUSE_D + 0.02, 10);
    expect(railPoint(0, 0, 0, 0)[1]).toBeCloseTo(HOUSE_D + 0.02 + LADDER_OUT, 10);
  });

  it('stands clear of the door', () => {
    expect((LADDER_AT + RAIL_GAP) * U).toBeLessThan(DOOR.u);
  });
});

describe('the roof', () => {
  it('its far slope is turned away from the eye: it rises at least as steeply as 45 degrees', () => {
    // The projection's eye looks along (1, 1, 1) (lib/iso.ts: x and y both run down the sheet,
    // z up). A slope facing -y with normal (0, -sin t, cos t) is seen only when cos t > sin t.
    const t = Math.atan2(RISE, HOUSE_D / 2);
    expect(Math.cos(t) - Math.sin(t)).toBeLessThanOrEqual(1e-12);
  });
});

describe('a picture on a bungalow', () => {
  const x = 4;
  const y = 3;
  const front = wallMatrix([x, y + HOUSE_D, RIDGE], 'x', U);
  const gable = wallMatrix([x + HOUSE_W, y + HOUSE_D, RIDGE], '-y', U);
  const at = (p: P3) => iso(p, U);

  it('on the front wall: one unit across is one unit along the street, one unit down is one unit lower', () => {
    close(apply(front, [0, 0]), at([x, y + HOUSE_D, RIDGE]));
    close(apply(front, [HOUSE_W * U, 0]), at([x + HOUSE_W, y + HOUSE_D, RIDGE]));
    close(apply(front, [0, RIDGE * U]), at([x, y + HOUSE_D, 0]));
    close(apply(front, [HOUSE_W * U, RIDGE * U]), at([x + HOUSE_W, y + HOUSE_D, 0]));
  });

  it('on the gable wall: it runs back from the front corner, at the same scale', () => {
    close(apply(gable, [0, 0]), at([x + HOUSE_W, y + HOUSE_D, RIDGE]));
    close(apply(gable, [HOUSE_D * U, 0]), at([x + HOUSE_W, y, RIDGE]));
    close(apply(gable, [HOUSE_D * U, RIDGE * U]), at([x + HOUSE_W, y, 0]));
  });

  it('meets itself at the corner: the front wall’s right edge is the gable wall’s left edge, at every height', () => {
    for (const h of [0, RISE * U, RIDGE * U * 0.5, RIDGE * U]) {
      close(apply(front, [HOUSE_W * U, h]), apply(gable, [0, h]));
    }
  });

  it('the front wall’s seen band runs from under the eave to the plinth', () => {
    // The eave's lower edge, OVER_EAVE out at EAVE_Z - ROOF_THICK, lands on the wall at that height less OVER_EAVE.
    const edge = at([x + 1, y + HOUSE_D + OVER_EAVE, EAVE_Z - ROOF_THICK]);
    close(apply(front, [(1 - OVER_EAVE) * U, FRONT_BAND.top]), edge);
    expect(FRONT_BAND.top).toBeGreaterThan(FRONT_WALL.top);
    expect(FRONT_BAND.bottom).toBeLessThan(MURAL_H);
  });

  it('its subject is set in the middle of the clear wall between the ladder and the door', () => {
    expect(MURAL_TARGET.u).toBeGreaterThan((LADDER_AT + RAIL_GAP) * U);
    expect(MURAL_TARGET.u).toBeLessThan(DOOR.u);
    expect(MURAL_TARGET.v).toBeGreaterThan(FRONT_BAND.top);
    expect(MURAL_TARGET.v).toBeLessThan(FRONT_BAND.bottom);
  });

  it('reads a room’s object-position as CSS does, in the hall’s door card (271 by 128, as a desktop draws it)', () => {
    expect(DOOR_CARD_ASPECT).toBeCloseTo(271 / 128, 12);
    // A square picture in the wide card: the card shows its whole width and 128/271 of its height.
    const sq = cardCrop({ w: 1000, h: 1000 }, '50% 4%');
    expect(sq.kx).toBe(1);
    expect(sq.ky).toBeCloseTo(1 / DOOR_CARD_ASPECT, 10);
    expect(sq.fx).toBeCloseTo(0.5, 10);
    expect(sq.fy).toBeCloseTo(0.04 * (1 - sq.ky) + sq.ky / 2, 10);
    // A picture wider than the card: its whole height shows, so a vertical position changes nothing.
    const wide = cardCrop({ w: 3000, h: 1000 }, '20% 90%');
    expect(wide.ky).toBe(1);
    expect(wide.fy).toBeCloseTo(0.5, 10);
    expect(wide.fx).toBeCloseTo(0.2 * (1 - wide.kx) + wide.kx / 2, 10);
    // Unread: CSS's own 50% 50%.
    expect(cardCrop({ w: 800, h: 1000 })).toMatchObject({ fx: 0.5, fy: 0.5 });
  });

  // The island's real door pictures (aspects 0.70 to 1.51), and two wider than covering the wall at the card's crop allows.
  it.each([
    ['0.70 tall', { w: 1434, h: 2048 }, '50% 41%', 'crop'],
    ['0.75 tall', { w: 931, h: 1248 }, '50% 43%', 'crop'],
    ['square, its crop at the top', { w: 2048, h: 2048 }, '50% 4%', 'crop'],
    ['0.95 tall', { w: 2160, h: 2278 }, '50% 48%', 'crop'],
    ['1.33, its crop near the top', { w: 738, h: 554 }, '50% 16%', 'crop'],
    ['1.51 wide', { w: 2048, h: 1356 }, '50% 50%', 'crop'],
    ['1.9 wide', { w: 1900, h: 1000 }, '50% 50%', 'cover'],
    ['2.6, wider than the card', { w: 2600, h: 1000 }, '30% 50%', 'cover'],
  ] as const)('a %s picture covers the front wall, its door card’s crop filling the seen band, centred on the clear wall', (_, natural, position, holds) => {
    const f = muralFrame(natural, position);
    const crop = cardCrop(natural, position);
    const band = FRONT_BAND.bottom - FRONT_BAND.top;
    expect(f.width / f.height).toBeCloseTo(natural.w / natural.h, 6);
    // The front wall is always covered.
    expect(f.x).toBeLessThanOrEqual(1e-9);
    expect(f.x + f.width).toBeGreaterThanOrEqual(FRONT_WALL.right - 1e-9);
    expect(f.y).toBeLessThanOrEqual(FRONT_WALL.top + 1e-9);
    expect(f.y + f.height).toBeGreaterThanOrEqual(FRONT_WALL.bottom - 1e-9);
    const cover = Math.max(FRONT_WALL.right / natural.w, (FRONT_WALL.bottom - FRONT_WALL.top) / natural.h);
    if (holds === 'crop') {
      // The band the eye sees holds exactly the card's crop, top to bottom, and so it lies as wide as every other picture.
      expect(band / f.height).toBeCloseTo(crop.ky, 9);
      expect(f.width).toBeCloseTo(MURAL_ACROSS, 9);
      expect(f.width / natural.w).toBeGreaterThan(cover);
    } else {
      // Too wide to show the card's whole crop and still cover the wall: laid at covering, no
      // larger, so the band shows a little less of it than the card does.
      expect(f.width / natural.w).toBeCloseTo(cover, 12);
      expect(band / f.height).toBeLessThan(crop.ky);
    }
    // Across, the crop's middle lands on the target; down, inside the band the eye sees.
    expect(f.x + crop.fx * f.width).toBeCloseTo(MURAL_TARGET.u, 6);
    const v = f.y + crop.fy * f.height;
    expect(v).toBeGreaterThan(FRONT_BAND.top);
    expect(v).toBeLessThan(FRONT_BAND.bottom);
  });

  it.each([
    ['0.70 tall', { w: 1434, h: 2048 }, '50% 41%'],
    ['square', { w: 2048, h: 2048 }, '50% 4%'],
    ['1.51 wide', { w: 2048, h: 1356 }, '20% 50%'],
    ['0.5, taller than the gable', { w: 1000, h: 2000 }, '50% 10%'],
  ] as const)('a %s picture covers the whole gable too, as CSS lays it in a box the gable’s size', (_, natural, position) => {
    const f = gableFrame(natural, position);
    expect(f.width / f.height).toBeCloseTo(natural.w / natural.h, 6);
    expect(f.x).toBeLessThanOrEqual(1e-9);
    expect(f.y).toBeLessThanOrEqual(1e-9);
    expect(f.x + f.width).toBeGreaterThanOrEqual(GABLE_WALL.right - 1e-9);
    expect(f.y + f.height).toBeGreaterThanOrEqual(GABLE_WALL.bottom - 1e-9);
    // Covering and no larger: one side meets the gable's own.
    const fits = Math.min(Math.abs(f.width - GABLE_WALL.right), Math.abs(f.height - GABLE_WALL.bottom));
    expect(fits).toBeLessThan(1e-9);
    // object-position: the part left over on each side is split as CSS splits it.
    const [px, py] = position.split(' ').map((s) => Number.parseFloat(s) / 100) as [number, number];
    expect(f.x).toBeCloseTo((GABLE_WALL.right - f.width) * px, 9);
    expect(f.y).toBeCloseTo((GABLE_WALL.bottom - f.height) * py, 9);
  });

  it('the gable is the wall the house is deep, peak to ground', () => {
    expect(GABLE_WALL.right).toBe(HOUSE_D * U);
    expect(GABLE_WALL.bottom).toBe(MURAL_H);
  });
});

describe('the shapes that take the pointer', () => {
  const x = 3;
  const y = 2;

  it('hold the whole roof and the eave, with the roof on', () => {
    const body = houseOutline(x, y);
    for (const corner of roofOutline(x, y)) expect(clearance(corner, body)).toBeLessThanOrEqual(0.5);
  });

  it('never reach past the front wall’s left edge below the eave, anywhere along their edges', () => {
    const wallLeft = iso([x, y + HOUSE_D, 0], U)[0];
    const eaveFoot = iso([x, y + HOUSE_D, EAVE_Z - ROOF_THICK - OVER_EAVE], U)[1];
    const outline = houseOutline(x, y);
    outline.forEach((a, i) => {
      const b = outline[(i + 1) % outline.length]!;
      for (let t = 0; t <= 1; t += 0.05) {
        const px = a[0] + (b[0] - a[0]) * t;
        const py = a[1] + (b[1] - a[1]) * t;
        if (px < wallLeft - 0.01) expect(py).toBeLessThanOrEqual(eaveFoot + 0.01);
      }
    });
  });

  it('take the chimney’s stack and its cap, each as its own shape', () => {
    const c = chimneyBox(x, y);
    const [stack, cap] = chimneyOutlines(x, y);
    for (const p of [[c.cx, c.cy, c.base], [c.cx + c.size, c.cy + c.size, c.top]] as P3[]) expect(clearance(iso(p, U), stack!)).toBeLessThanOrEqual(0.01);
    for (const p of [[c.cx - c.capOver, c.cy - c.capOver, c.top + c.cap], [c.cx + c.size + c.capOver, c.cy + c.size + c.capOver, c.top]] as P3[]) {
      expect(clearance(iso(p, U), cap!)).toBeLessThanOrEqual(0.01);
    }
    // The stack stands on the near slope: the middle of its front face's foot is inside the house's own shape.
    expect(inside(iso([c.cx + c.size / 2, c.cy + c.size, c.base], U), houseOutline(x, y))).toBe(true);
  });

  it('are the same shape on every plot', () => {
    const a = houseOutline(0, 0);
    const b = houseOutline(11.4, 7.6);
    const [dx, dy] = [b[0]![0] - a[0]![0], b[0]![1] - a[0]![1]];
    a.forEach((p, i) => close([p[0] + dx, p[1] + dy], b[i]!));
  });
});

describe('the drawing’s bounds', () => {
  it('hold a bungalow with its roof lifted off and its name over it', () => {
    const box = bungalowBox(0, 0);
    const top = Math.min(...box.map(([, sy]) => sy));
    const baseline = iso([HOUSE_W / 2, HOUSE_D / 2, RIDGE + ROOF_LIFT + LABEL_Z], U)[1] - LABEL_GAP_PX;
    expect(top).toBeLessThanOrEqual(baseline - LABEL_PX);
    expect(top).toBeLessThan(iso([HOUSE_W / 2, HOUSE_D / 2, RIDGE + ROOF_LIFT], U)[1]);
  });

  it('hold the house, its ladder’s feet, and its roof and chimney lifted off, on every side', () => {
    const box = bungalowBox(0, 0);
    const xs = box.map(([sx]) => sx);
    const ys = box.map(([, sy]) => sy);
    const lift = (p: Pt): Pt => [p[0], p[1] - ROOF_LIFT * U];
    const drawn: Pt[] = [
      ...houseOutline(0, 0),
      ...roofOutline(0, 0).map(lift),
      ...chimneyOutlines(0, 0).flat().map(lift),
      iso(railPoint(0, 0, 0, 0), U),
      iso(railPoint(0, 0, 1, 0), U),
    ];
    for (const [sx, sy] of drawn) {
      expect(sx).toBeGreaterThanOrEqual(Math.min(...xs));
      expect(sx).toBeLessThanOrEqual(Math.max(...xs));
      expect(sy).toBeGreaterThanOrEqual(Math.min(...ys));
      expect(sy).toBeLessThanOrEqual(Math.max(...ys));
    }
    expect(roofCorners(0, 0).eaveL[2]).toBeCloseTo(EAVE_Z, 10);
  });
});
