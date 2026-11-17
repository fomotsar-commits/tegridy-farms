import { describe, it, expect } from 'vitest';
import { iso, type Pt } from '../../lib/iso';
import { MAX_BOOST_BPS, MIN_BOOST_BPS } from '../../lib/constants';
import { RUNG_HIGH, U, chimneyOutlines, houseOutline, railPoint } from '../../lib/isoBungalow';
import type { LadderRung } from '../../lib/ladderPick';
import { DIM_OFF, TAG_ROOM, heldMark, ladderScene, rungZ, type LadderScene } from './ladderScene';

// The seven locks the BAYLA ladder offers, as SolanaLadderPoolLive publishes them.
const SEVEN: LadderRung[] = [
  [4_000, '7d'], [4_569, '30d'], [6_056, '90d'], [8_286, '180d'], [12_869, '1y'], [21_913, '2y'], [40_000, '4y'],
].map(([bps, lock]) => ({ bps: bps as number, lock: lock as string, weight: `${((bps as number) / 10_000).toFixed(2)}×` }));

const near = (a: Pt, b: Pt) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};
/** Every point the figure draws, its words' anchors included. */
function drawn(s: LadderScene): Pt[] {
  const seg = (list: readonly (readonly [Pt, Pt])[]) => list.flatMap(([a, b]) => [a, b]);
  const pick = s.pick ? [s.pick.at, [s.pick.at[0], s.pick.at[1] + s.pick.run] as Pt, s.pick.tag, [s.pick.at[0] - DIM_OFF, s.pick.at[1]] as Pt] : [];
  const held = s.held.flatMap((q) => { const m = heldMark(q); return [[m.x, m.y], [m.x + m.size, m.y + m.size]] as Pt[]; });
  return [
    ...s.plot, ...s.path, ...seg(s.rails), ...seg(s.climbed), ...s.rungs.flatMap((r) => [r.a, r.b]), ...held, ...pick,
    ...seg(s.leaders), s.bubbles[0], s.bubbles[1], s.plate, ...s.meter.corners,
    ...houseOutline(0, 0), ...chimneyOutlines(0, 0).flat(),
  ];
}
const inside = (s: LadderScene, [x, y]: Pt) => x >= s.box.x && x <= s.box.x + s.box.w && y >= s.box.y && y <= s.box.y + s.box.h;

describe("S-01's figure: the house's lock ladder (components/dwg/ladderHouse.ts)", () => {
  it('stands every rung as high as its weight, to scale: z = RUNG_HIGH * bps / MAX_BOOST_BPS', () => {
    const s = ladderScene({ rungs: SEVEN, picked: 0, held: null, tagRoom: TAG_ROOM.hero });
    expect(s.rungs).toHaveLength(7);
    SEVEN.forEach((r, i) => {
      const z = (RUNG_HIGH * r.bps) / MAX_BOOST_BPS;
      expect(rungZ(r.bps)).toBeCloseTo(z, 9);
      near(s.rungs[i]!.a, iso(railPoint(0, 0, 0, z), U));
      near(s.rungs[i]!.b, iso(railPoint(0, 0, 1, z), U));
    });
    // 0.40x stands a tenth as high as 4.00x.
    expect(rungZ(MIN_BOOST_BPS) / rungZ(MAX_BOOST_BPS)).toBeCloseTo(0.1, 9);
  });

  it("measures the pick from the ground: its run is its height times U, at the rung's left end", () => {
    for (const picked of [0, 4, 6]) {
      const s = ladderScene({ rungs: SEVEN, picked, held: null, tagRoom: TAG_ROOM.hero });
      const z = rungZ(SEVEN[picked]!.bps);
      expect(s.pick).not.toBeNull();
      expect(s.pick!.rung).toBe(SEVEN[picked]);
      expect(s.pick!.run).toBeCloseTo(z * U, 9);
      near(s.pick!.at, iso(railPoint(0, 0, 0, z), U));
      expect(s.rungs.map((r) => r.on)).toEqual(SEVEN.map((_, i) => i === picked));
      expect(s.rungs.map((r) => r.climbed)).toEqual(SEVEN.map((_, i) => i < picked));
      expect(s.climbed).toHaveLength(2);
    }
  });

  it('draws the two rungs the contract fixes, and no pick and no tag, before the staircase publishes', () => {
    const s = ladderScene({ rungs: null, picked: 3, held: null, tagRoom: TAG_ROOM.hero });
    expect(s.rungs).toHaveLength(2);
    near(s.rungs[0]!.a, iso(railPoint(0, 0, 0, rungZ(MIN_BOOST_BPS)), U));
    near(s.rungs[1]!.a, iso(railPoint(0, 0, 0, rungZ(MAX_BOOST_BPS)), U));
    expect(s.pick).toBeNull();
    expect(s.climbed).toHaveLength(0);
    expect(s.rungs.some((r) => r.on || r.climbed)).toBe(false);
  });

  it('marks no position for a wallet not read, and one on the right rail at each weight held', () => {
    expect(ladderScene({ rungs: SEVEN, picked: 0, held: null, tagRoom: 28 }).held).toEqual([]);
    expect(ladderScene({ rungs: SEVEN, picked: 0, held: [], tagRoom: 28 }).held).toEqual([]);
    const s = ladderScene({ rungs: SEVEN, picked: 0, held: [12_869, 4_569], tagRoom: 28 });
    expect(s.held).toHaveLength(2);
    near(s.held[0]!, iso(railPoint(0, 0, 1, rungZ(12_869)), U));
    near(s.held[1]!, iso(railPoint(0, 0, 1, rungZ(4_569)), U));
  });

  it('holds every point it draws inside its box, in both placements and every state', () => {
    const states = [
      { rungs: null, picked: null, held: null },
      { rungs: SEVEN, picked: 0, held: null },
      { rungs: SEVEN, picked: 6, held: [40_000, 4_000] },
    ];
    for (const st of states) {
      for (const tagRoom of [TAG_ROOM.hero, TAG_ROOM.rail]) {
        const s = ladderScene({ ...st, tagRoom });
        const out = drawn(s).filter((p) => !inside(s, p));
        expect(out, `outside ${JSON.stringify(s.box)}`).toEqual([]);
      }
    }
    // The rail's figure is drawn smaller, so its tag gets more of the drawing's units.
    const hero = ladderScene({ rungs: SEVEN, picked: 0, held: null, tagRoom: TAG_ROOM.hero });
    const rail = ladderScene({ rungs: SEVEN, picked: 0, held: null, tagRoom: TAG_ROOM.rail });
    expect(rail.box.w).toBeGreaterThan(hero.box.w);
  });
});
